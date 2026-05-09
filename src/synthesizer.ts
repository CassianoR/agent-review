import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentResult, Diff, Finding, ReviewReport, RunConfig, TokenUsage } from './types.js';
import {
  FindingsArraySchema,
  SEVERITY_ORDER,
  addUsage,
  computeCost,
  zeroUsage,
} from './types.js';

// ── Public API ────────────────────────────────────────────────────────────────

export async function synthesize(
  results: AgentResult[],
  diff: Diff,
  config: RunConfig,
): Promise<ReviewReport> {
  const systemPrompt = await readFile(join(config.promptsDir, 'synthesizer.md'), 'utf-8');

  // Gather all findings from successful agents, tag each with source agent
  const allFindings: Array<Finding & { _source: string }> = results
    .filter((r) => r.status === 'success')
    .flatMap((r) => r.findings.map((f) => ({ ...f, _source: r.agentName })));

  const userMessage = buildSynthesizerMessage(allFindings, results, diff);

  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 3 });
  const response = await client.messages.create({
    model: config.model,
    max_tokens: 8000,
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
    throw new Error('Synthesizer returned no text content from the API');
  }

  const markdownBody = textBlock.text;

  const synthUsage = buildTokenUsage(response.usage, config.model);
  const totalUsage = [
    ...results.map((r) => r.tokenUsage),
    synthUsage,
  ].reduce(addUsage, zeroUsage());

  // Extract deduplicated findings from the hidden JSON block embedded in Markdown
  const findings = extractFindings(markdownBody, allFindings);

  return {
    summary: extractSummary(markdownBody),
    findings,
    agentResults: results,
    totalUsage,
    hasCritical: findings.some((f) => f.severity === 'critical'),
    markdownBody: injectUsageFooter(markdownBody, totalUsage),
    generatedAt: new Date().toISOString(),
  };
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildSynthesizerMessage(
  allFindings: Array<Finding & { _source: string }>,
  results: AgentResult[],
  diff: Diff,
): string {
  const agentSummary = results.map((r) => ({
    agent: r.agentName,
    status: r.status,
    findingCount: r.findings.length,
    error: r.error ?? null,
  }));

  return JSON.stringify(
    {
      diff_summary: {
        base: diff.base,
        head: diff.head,
        filesChanged: diff.files.length,
        totalAdditions: diff.totalAdditions,
        totalDeletions: diff.totalDeletions,
      },
      agents: agentSummary,
      findings: allFindings,
    },
    null,
    2,
  );
}

// ── Response parsers ──────────────────────────────────────────────────────────

export function extractFindings(
  markdown: string,
  fallback: Finding[],
): Finding[] {
  const match = markdown.match(/<!--\s*FINDINGS_JSON\s*([\s\S]*?)\s*-->/);
  if (match) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? '[]');
      const result = FindingsArraySchema.safeParse(parsed);
      if (result.success) {
        return result.data.slice().sort(bySeverity);
      }
    } catch {
      // fall through to fallback
    }
  }
  // Fallback: return original findings sorted by severity
  return fallback.slice().sort(bySeverity);
}

export function extractSummary(markdown: string): string {
  // First paragraph of text after the # heading
  const lines = markdown.split('\n');
  let capturing = false;
  const summaryLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;
    if (line.startsWith('## ') || line.startsWith('---')) break;
    if (line.trim() === '' && summaryLines.length > 0) break;
    if (line.trim() !== '') summaryLines.push(line);
  }

  return summaryLines.join(' ').trim();
}

function injectUsageFooter(markdown: string, usage: TokenUsage): string {
  const footer = [
    '',
    '## Token Usage',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Input tokens | ${usage.inputTokens.toLocaleString('en-US')} |`,
    `| Output tokens | ${usage.outputTokens.toLocaleString('en-US')} |`,
    `| Cache read tokens | ${usage.cacheReadTokens.toLocaleString('en-US')} |`,
    `| Cache write tokens | ${usage.cacheWriteTokens.toLocaleString('en-US')} |`,
    `| **Estimated cost** | **$${usage.estimatedCostUsd.toFixed(4)}** |`,
  ].join('\n');

  return markdown.replace('<!-- TOKEN_USAGE_PLACEHOLDER -->', footer);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bySeverity(a: Finding, b: Finding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

function buildTokenUsage(raw: Anthropic.Usage, model: string): TokenUsage {
  const u = raw as Anthropic.Usage & {
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  const base = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
  return { ...base, estimatedCostUsd: computeCost(base, model) };
}
