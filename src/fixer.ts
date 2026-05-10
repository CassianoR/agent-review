/**
 * --fix mode: applies LLM-generated patches to source files.
 *
 * Design principles:
 *   - Findings are grouped by file — one API call per file fixes ALL eligible
 *     issues in that file simultaneously. This dramatically reduces cost and
 *     latency compared to one call per finding.
 *   - Files are processed in parallel via Promise.allSettled. A failure on one
 *     file never blocks other files from being fixed.
 *   - Critical and high findings are always excluded regardless of maxSeverity.
 *   - A sanity check rejects patches that shrink the file by more than 50 %,
 *     which catches model truncation before it reaches disk.
 *   - The original file is never overwritten without a successful, non-empty
 *     response that passes the sanity check.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPatch } from 'diff';
import type { Finding, RunConfig, Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';
import { createProvider } from './providers/index.js';
import type { LLMProvider } from './providers/base.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Result for a single file processed by the fixer.
 * One FixResult is produced per file (not per finding).
 */
export interface FixResult {
  /** Absolute path to the file on disk. */
  filePath: string;
  /** Path relative to repoRoot — used for display and diff headers. */
  relPath: string;
  /** All eligible findings that were submitted for this file. */
  findings: Finding[];
  status: 'applied' | 'skipped' | 'failed';
  /** Human-readable reason when status is "skipped" or "failed". */
  reason?: string;
  /** Original file content (present when the file was successfully read). */
  originalContent?: string;
  /** Patched file content (present when the model returned a change). */
  patchedContent?: string;
  /**
   * Unified diff string (--- original / +++ fixed).
   * Present whenever patchedContent differs from originalContent,
   * including dry-run mode.
   */
  patch?: string;
  /** Number of lines added in the patch (for compact summaries). */
  linesAdded?: number;
  /** Number of lines removed in the patch (for compact summaries). */
  linesRemoved?: number;
}

export interface FixerOptions {
  /**
   * Only attempt fixes for findings at or below this severity.
   * Defaults to 'low'. Critical and high are always excluded.
   */
  maxSeverity?: Severity;
  /** Absolute path to the repository root. */
  repoRoot: string;
  /**
   * If true, compute patches and display diffs but do NOT write to disk.
   * Useful for previewing what --fix would do before committing.
   */
  dryRun?: boolean;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Groups eligible findings by file, then processes each file in parallel.
 * Returns one FixResult per file (not per finding).
 *
 * @example
 * const results = await applyFixes(report.findings, config, { repoRoot, dryRun: true });
 */
export async function applyFixes(
  findings: Finding[],
  config: RunConfig,
  opts: FixerOptions,
): Promise<FixResult[]> {
  const maxSev = opts.maxSeverity ?? 'low';
  const threshold = SEVERITY_ORDER[maxSev];

  // Critical and high are ALWAYS excluded, regardless of threshold.
  const eligible = findings.filter(
    (f) =>
      f.severity !== 'critical' &&
      f.severity !== 'high' &&
      SEVERITY_ORDER[f.severity] >= threshold,
  );

  if (eligible.length === 0) return [];

  const provider = createProvider(config.providerName, {
    anthropicApiKey: config.apiKey,
    openaiApiKey: config.openaiApiKey,
    model: config.model,
  });

  // Group findings by file path — one API call handles all issues in a file.
  const byFile = new Map<string, Finding[]>();
  for (const f of eligible) {
    const arr = byFile.get(f.file) ?? [];
    arr.push(f);
    byFile.set(f.file, arr);
  }

  // Process each file in parallel. Files are independent — no ordering needed.
  const settled = await Promise.allSettled(
    [...byFile.entries()].map(([relPath, fileFindings]) =>
      fixFile(relPath, fileFindings, config, opts, provider),
    ),
  );

  return settled.map((outcome) => {
    if (outcome.status === 'fulfilled') return outcome.value;
    // A Promise itself rejected — shouldn't happen with our wrapper, but guard anyway.
    return {
      filePath: '',
      relPath: '',
      findings: [],
      status: 'failed' as const,
      reason:
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason),
    };
  });
}

// ── Per-file worker ───────────────────────────────────────────────────────────

async function fixFile(
  relPath: string,
  findings: Finding[],
  config: RunConfig,
  opts: FixerOptions,
  provider: LLMProvider,
): Promise<FixResult> {
  const filePath = join(opts.repoRoot, relPath);

  if (!existsSync(filePath)) {
    return {
      filePath,
      relPath,
      findings,
      status: 'skipped',
      reason: 'File does not exist in the working tree',
    };
  }

  let originalContent: string;
  try {
    originalContent = await readFile(filePath, 'utf-8');
  } catch (err) {
    return {
      filePath,
      relPath,
      findings,
      status: 'failed',
      reason: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const systemPrompt = buildFixSystemPrompt();
  const userMessage = buildFixUserMessage(findings, relPath, originalContent);

  let patchedContent: string;
  let skipReason: string | undefined;
  try {
    const response = await provider.complete(systemPrompt, userMessage, {
      model: config.model,
      maxTokens: 8000,
    });
    const extracted = extractFixedFile(response.content, originalContent);
    patchedContent = extracted.content;
    skipReason = extracted.skipReason;
  } catch (err) {
    return {
      filePath,
      relPath,
      findings,
      status: 'failed',
      reason: `API call failed: ${err instanceof Error ? err.message : String(err)}`,
      originalContent,
    };
  }

  // Model signalled it cannot safely fix this file
  if (skipReason !== undefined) {
    return {
      filePath,
      relPath,
      findings,
      status: 'skipped',
      reason: skipReason,
      originalContent,
    };
  }

  if (patchedContent === originalContent) {
    return {
      filePath,
      relPath,
      findings,
      status: 'skipped',
      reason: 'Model returned unchanged content',
      originalContent,
      patchedContent,
    };
  }

  // Safety guard: reject patches that shrink the file by more than 50 %.
  // This catches cases where the model truncates the file instead of editing it.
  const sanity = sanityCheck(originalContent, patchedContent);
  if (!sanity.safe) {
    return {
      filePath,
      relPath,
      findings,
      status: 'skipped',
      reason: sanity.reason,
      originalContent,
      patchedContent,
    };
  }

  // Compute a unified diff for display / dry-run preview.
  const patch = createPatch(relPath, originalContent, patchedContent, 'original', 'fixed');
  const { added, removed } = countDiffLines(patch);

  if (!opts.dryRun) {
    try {
      await writeFile(filePath, patchedContent, 'utf-8');
    } catch (err) {
      return {
        filePath,
        relPath,
        findings,
        status: 'failed',
        reason: `Could not write file: ${err instanceof Error ? err.message : String(err)}`,
        originalContent,
        patchedContent,
        patch,
        linesAdded: added,
        linesRemoved: removed,
      };
    }
  }

  return {
    filePath,
    relPath,
    findings,
    status: 'applied',
    originalContent,
    patchedContent,
    patch,
    linesAdded: added,
    linesRemoved: removed,
  };
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildFixSystemPrompt(): string {
  return `You are a precise code editor. You receive a source file and one or more findings (issues detected by a code review). Your job is to apply all the suggested fixes in a single pass.

## Rules
1. Return the COMPLETE file content after applying ALL fixes — not a diff, not a snippet.
2. Make ONLY the changes described in the findings. Do not refactor, reformat, rename, or improve anything else.
3. Preserve the exact whitespace, indentation style, and line endings of the original file.
4. If multiple findings affect the same area of code, apply them together coherently.
5. Wrap your response in a \`\`\`fix code block:

\`\`\`fix
<entire file content here>
\`\`\`

6. If you cannot safely apply ALL fixes without introducing side effects or breaking changes, respond with:
\`\`\`fix
SKIP: <one-line explanation of why the fixes cannot be applied safely>
\`\`\`

Do not apply partial fixes — either fix everything or skip everything.`;
}

function buildFixUserMessage(findings: Finding[], relPath: string, fileContent: string): string {
  const plural = findings.length !== 1;
  const lines: string[] = [
    `## ${findings.length} finding${plural ? 's' : ''} to fix in \`${relPath}\``,
    '',
  ];

  findings.forEach((f, i) => {
    const loc = f.line !== null ? ` (line ${f.line})` : '';
    lines.push(
      `### Finding ${i + 1}${loc} — ${f.category} [${f.severity}]`,
      `**Description:** ${f.description}`,
      `**Suggestion:** ${f.suggestion}`,
      '',
    );
  });

  lines.push(
    `## Current file content`,
    '',
    '```',
    fileContent,
    '```',
    '',
    `Apply ${plural ? `all ${findings.length} suggestions` : 'the suggestion'} above. Return the complete fixed file wrapped in a \`\`\`fix block.`,
  );

  return lines.join('\n');
}

// ── Response parser ───────────────────────────────────────────────────────────

function extractFixedFile(
  response: string,
  originalContent: string,
): { content: string; skipReason?: string } {
  const match = response.match(/```fix\s*([\s\S]*?)```/);
  if (!match) return { content: originalContent };

  const body = (match[1] ?? '').trim();

  if (body.startsWith('SKIP:')) {
    const reason = body.slice(5).trim() || 'Model indicated fixes cannot be applied safely';
    return { content: originalContent, skipReason: reason };
  }

  return { content: body };
}

// ── Safety check ──────────────────────────────────────────────────────────────

/**
 * Rejects patches where the model clearly truncated the file rather than
 * editing it. A legitimate fix should never remove more than half the content.
 */
function sanityCheck(
  original: string,
  patched: string,
): { safe: boolean; reason: string } {
  const origLines = original.split('\n').length;
  const patchedLines = patched.split('\n').length;

  if (patchedLines < Math.ceil(origLines * 0.5)) {
    return {
      safe: false,
      reason:
        `Patch rejected — file shrank from ${origLines} to ${patchedLines} lines ` +
        `(>${Math.round((1 - patchedLines / origLines) * 100)}% reduction). ` +
        `The model may have truncated the file instead of editing it.`,
    };
  }

  return { safe: true, reason: '' };
}

// ── Diff helpers ──────────────────────────────────────────────────────────────

function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}
