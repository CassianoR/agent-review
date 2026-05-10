import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import micromatch from 'micromatch';
import type { AgentConfig, AgentResult, Diff, DiffFile, Finding } from '../types.js';
import { FindingSchema, FindingsArraySchema, zeroUsage } from '../types.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import type { LLMProvider } from '../providers/base.js';

// ── Public interface ──────────────────────────────────────────────────────────

export interface Agent {
  readonly name: string;
  review(diff: Diff, config: AgentConfig): Promise<AgentResult>;
}

// ── Base implementation ───────────────────────────────────────────────────────

export abstract class BaseAgent implements Agent {
  abstract readonly name: string;
  protected abstract readonly promptFile: string;

  async review(diff: Diff, config: AgentConfig): Promise<AgentResult> {
    const startMs = Date.now();
    try {
      const systemPrompt = await this.loadPrompt(config.promptsDir);
      const filteredDiff = filterDiff(diff, config.ignorePatterns);
      const userMessage = buildUserMessage(filteredDiff);

      // Use injected provider if supplied, otherwise default to Anthropic
      const provider: LLMProvider =
        config.provider ?? new AnthropicProvider(config.apiKey, config.model);

      const { content, usage } = await provider.complete(systemPrompt, userMessage, {
        model: config.model,
        maxTokens: config.maxTokens,
      });

      const findings = parseFindings(content, this.name);

      return {
        agentName: this.name,
        status: 'success',
        findings,
        tokenUsage: usage,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        agentName: this.name,
        status: 'failed',
        findings: [],
        tokenUsage: zeroUsage(),
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startMs,
      };
    }
  }

  private async loadPrompt(promptsDir: string): Promise<string> {
    const filePath = join(promptsDir, `${this.promptFile}.md`);
    return readFile(filePath, 'utf-8');
  }
}

// ── Exported helpers (used in tests) ─────────────────────────────────────────

export function filterDiff(diff: Diff, ignorePatterns: string[]): Diff {
  if (ignorePatterns.length === 0) return diff;
  const ignored = new Set(micromatch(diff.files.map((f) => f.path), ignorePatterns));
  const files = diff.files.filter((f) => !ignored.has(f.path));
  return {
    ...diff,
    files,
    rawDiff: files.map((f: DiffFile) => f.patch).join('\n'),
    totalAdditions: files.reduce((s: number, f: DiffFile) => s + f.additions, 0),
    totalDeletions: files.reduce((s: number, f: DiffFile) => s + f.deletions, 0),
  };
}

export function buildUserMessage(diff: Diff): string {
  const MAX_DIFF_CHARS = 150_000;
  let rawDiff = diff.rawDiff;
  let truncated = false;
  if (rawDiff.length > MAX_DIFF_CHARS) {
    rawDiff = rawDiff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  return [
    `## Code diff to review`,
    ``,
    `Base: ${diff.base} → ${diff.head}`,
    `Files changed: ${diff.files.length} (+${diff.totalAdditions} -${diff.totalDeletions})`,
    truncated ? `\n> **Warning:** Diff truncated at ${MAX_DIFF_CHARS} characters.\n` : '',
    ``,
    '```diff',
    rawDiff,
    '```',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

export function parseFindings(content: string, agentName: string): Finding[] {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? (jsonMatch[1] ?? '').trim() : content.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    console.warn(`[${agentName}] Could not parse JSON response; skipping findings.`);
    return [];
  }

  const result = FindingsArraySchema.safeParse(parsed);
  if (result.success) return result.data;

  console.warn(`[${agentName}] Findings failed schema validation: ${result.error.message}`);

  if (Array.isArray(parsed)) {
    const valid: Finding[] = [];
    for (const item of parsed) {
      const r = FindingSchema.safeParse(item);
      if (r.success) valid.push(r.data);
    }
    return valid;
  }
  return [];
}
