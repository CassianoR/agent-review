import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding, RunConfig, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';
import { createProvider } from './providers/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FixResult {
  finding: Finding;
  filePath: string;
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  originalContent?: string;
  patchedContent?: string;
}

export interface FixerOptions {
  /**
   * Only attempt fixes for findings at or below this severity.
   * Defaults to 'low' — keeps auto-fix conservative and safe.
   */
  maxSeverity?: Severity;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /** If true, show the diff but don't write to disk. */
  dryRun?: boolean;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Attempts to apply fixes for a filtered set of findings using Claude.
 *
 * Only findings at or below `maxSeverity` are attempted (default: 'low').
 * Critical and high findings are intentionally excluded — auto-applying fixes
 * to security issues without human review is dangerous.
 *
 * Each fix is a separate API call so failures are isolated. The original file
 * is never overwritten without a successful, non-empty response.
 */
export async function applyFixes(
  findings: Finding[],
  config: RunConfig,
  opts: FixerOptions,
): Promise<FixResult[]> {
  const maxSev = opts.maxSeverity ?? 'low';
  const threshold = SEVERITY_ORDER[maxSev];

  const eligible = findings.filter(
    (f) => SEVERITY_ORDER[f.severity] >= threshold && f.severity !== 'critical' && f.severity !== 'high',
  );

  if (eligible.length === 0) return [];

  const provider = createProvider(config.providerName, {
    anthropicApiKey: config.apiKey,
    openaiApiKey: config.openaiApiKey,
    model: config.model,
  });

  const results: FixResult[] = [];

  for (const finding of eligible) {
    const filePath = join(opts.repoRoot, finding.file);

    if (!existsSync(filePath)) {
      results.push({
        finding,
        filePath,
        status: 'skipped',
        reason: 'File does not exist in the working tree',
      });
      continue;
    }

    let originalContent: string;
    try {
      originalContent = await readFile(filePath, 'utf-8');
    } catch (err) {
      results.push({
        finding,
        filePath,
        status: 'failed',
        reason: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Build a focused prompt for this single finding
    const systemPrompt = buildFixSystemPrompt();
    const userMessage = buildFixUserMessage(finding, originalContent);

    let patchedContent: string;
    try {
      const response = await provider.complete(systemPrompt, userMessage, {
        model: config.model,
        maxTokens: 8000,
      });
      patchedContent = extractFixedFile(response.content, originalContent);
    } catch (err) {
      results.push({
        finding,
        filePath,
        status: 'failed',
        reason: `API call failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (patchedContent === originalContent) {
      results.push({
        finding,
        filePath,
        status: 'skipped',
        reason: 'Model returned unchanged content',
        originalContent,
        patchedContent,
      });
      continue;
    }

    if (!opts.dryRun) {
      try {
        await writeFile(filePath, patchedContent, 'utf-8');
      } catch (err) {
        results.push({
          finding,
          filePath,
          status: 'failed',
          reason: `Could not write file: ${err instanceof Error ? err.message : String(err)}`,
          originalContent,
          patchedContent,
        });
        continue;
      }
    }

    results.push({
      finding,
      filePath,
      status: 'applied',
      originalContent,
      patchedContent,
    });
  }

  return results;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildFixSystemPrompt(): string {
  return `You are a precise code editor that applies a single targeted fix to a source file.

## Rules
1. Return the COMPLETE file content after applying the fix — not a diff, not a snippet.
2. Make ONLY the change described in the finding. Do not refactor, reformat, or improve anything else.
3. Preserve the exact whitespace, indentation style, and line endings of the original file.
4. Wrap your response in a \`\`\`fix code block:

\`\`\`fix
<entire file content here>
\`\`\`

5. If you cannot safely apply the fix without side effects, respond with:
\`\`\`fix
SKIP: <one-line reason>
\`\`\``;
}

function buildFixUserMessage(finding: Finding, fileContent: string): string {
  const loc = finding.line !== null ? ` (line ${finding.line})` : '';
  return [
    `## Finding to fix`,
    ``,
    `**File:** \`${finding.file}\`${loc}`,
    `**Category:** ${finding.category}`,
    `**Severity:** ${finding.severity}`,
    `**Description:** ${finding.description}`,
    `**Suggestion:** ${finding.suggestion}`,
    ``,
    `## Current file content`,
    ``,
    '```',
    fileContent,
    '```',
    ``,
    `Apply the suggestion above to the file. Return the complete fixed file in a \`\`\`fix block.`,
  ].join('\n');
}

// ── Response parser ───────────────────────────────────────────────────────────

function extractFixedFile(response: string, originalContent: string): string {
  const match = response.match(/```fix\s*([\s\S]*?)```/);
  if (!match) return originalContent;

  const body = (match[1] ?? '').trim();

  // Model signalled it can't safely apply the fix
  if (body.startsWith('SKIP:')) return originalContent;

  return body;
}
