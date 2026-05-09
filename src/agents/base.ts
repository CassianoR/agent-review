import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import micromatch from 'micromatch';
import type { AgentConfig, AgentResult, Diff, DiffFile, Finding, TokenUsage } from '../types.js';
import { FindingSchema, FindingsArraySchema, computeCost, zeroUsage } from '../types.js';

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
      const { content, usage } = await this.callApi(systemPrompt, userMessage, config);
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

  private async callApi(
    systemPrompt: string,
    userMessage: string,
    config: AgentConfig,
  ): Promise<{ content: string; usage: TokenUsage }> {
    const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 3 });

    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      throw new Error(`Agent ${this.name} returned no text content`);
    }

    const u = response.usage as Anthropic.Usage & {
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };

    const rawUsage = {
      inputTokens: u.input_tokens,
      outputTokens: u.output_tokens,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    };

    return {
      content: textBlock.text,
      usage: { ...rawUsage, estimatedCostUsd: computeCost(rawUsage, config.model) },
    };
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
  // Extract first ```json ... ``` block; fall back to bare JSON parse
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

  // Partial recovery: keep individually valid items
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
