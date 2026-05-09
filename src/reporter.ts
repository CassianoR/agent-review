import { writeFile } from 'node:fs/promises';
import type { AgentResult, Finding, ReviewReport, Severity, TokenUsage } from './types.js';
import { SEVERITY_ORDER } from './types.js';

// ── Primary renderers ─────────────────────────────────────────────────────────

/**
 * Returns the Markdown body produced by the synthesizer, with the token usage
 * footer already injected by synthesize(). This is the primary output path.
 */
export function renderMarkdown(report: ReviewReport): string {
  return report.markdownBody;
}

/**
 * Renders a structured JSON representation of the report — omits markdownBody
 * to keep output compact and machine-parseable.
 */
export function renderJson(report: ReviewReport): string {
  const { markdownBody: _omit, ...jsonSafe } = report;
  return JSON.stringify(jsonSafe, null, 2);
}

/**
 * Fallback Markdown builder used when the synthesizer fails or in tests.
 * Builds the report from scratch from the structured AgentResult data.
 */
export function buildMarkdownFromScratch(report: ReviewReport): string {
  const lines: string[] = [
    `# Code Review Report`,
    ``,
    `_Generated: ${report.generatedAt}_`,
    ``,
    report.summary || '_No summary available._',
    ``,
    buildSummaryTable(report.findings),
    ``,
    buildAgentTable(report.agentResults),
    ``,
    `## Findings`,
    ``,
  ];

  const bySev = groupBySeverity(report.findings);
  const ORDERED: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

  for (const sev of ORDERED) {
    const bucket = bySev.get(sev) ?? [];
    if (bucket.length === 0) continue;
    lines.push(`### ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} (${bucket.length})`);
    lines.push('');
    for (const f of bucket) {
      const loc = f.line !== null ? `:${f.line}` : '';
      lines.push(`#### [${f.category}] \`${f.file}${loc}\``);
      lines.push('');
      lines.push(f.description);
      lines.push('');
      lines.push(`> **Suggestion:** ${f.suggestion}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push(buildUsageTable(report.totalUsage));
  return lines.join('\n');
}

// ── File writer ───────────────────────────────────────────────────────────────

export async function writeReport(content: string, filePath: string): Promise<void> {
  await writeFile(filePath, content, 'utf-8');
}

// ── Section builders (exported for testing) ───────────────────────────────────

export function buildSummaryTable(findings: Finding[]): string {
  const c = countBySeverity(findings);
  return [
    `## Summary`,
    ``,
    `| Severity | Count |`,
    `|----------|-------|`,
    `| 🔴 Critical | ${c.critical} |`,
    `| 🟠 High     | ${c.high} |`,
    `| 🟡 Medium   | ${c.medium} |`,
    `| 🟢 Low      | ${c.low} |`,
    `| ℹ️ Info     | ${c.info} |`,
    `| **Total**   | **${findings.length}** |`,
  ].join('\n');
}

export function buildAgentTable(results: AgentResult[]): string {
  const rows = results.map((r) => {
    const icon = r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : '⏭️';
    const err = r.error ?? '—';
    return `| ${icon} ${r.agentName} | ${r.status} | ${r.findings.length} | ${r.durationMs}ms | $${r.tokenUsage.estimatedCostUsd.toFixed(4)} | ${err} |`;
  });
  return [
    `## Agent Results`,
    ``,
    `| Agent | Status | Findings | Duration | Cost | Error |`,
    `|-------|--------|----------|----------|------|-------|`,
    ...rows,
  ].join('\n');
}

export function buildUsageTable(usage: TokenUsage): string {
  return [
    `## Token Usage`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Input tokens | ${usage.inputTokens.toLocaleString('en-US')} |`,
    `| Output tokens | ${usage.outputTokens.toLocaleString('en-US')} |`,
    `| Cache read tokens | ${usage.cacheReadTokens.toLocaleString('en-US')} |`,
    `| Cache write tokens | ${usage.cacheWriteTokens.toLocaleString('en-US')} |`,
    `| **Estimated cost** | **$${usage.estimatedCostUsd.toFixed(4)}** |`,
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  info: 'ℹ️',
};

function groupBySeverity(findings: Finding[]): Map<Severity, Finding[]> {
  const map = new Map<Severity, Finding[]>();
  const sorted = findings.slice().sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
  for (const f of sorted) {
    const bucket = map.get(f.severity) ?? [];
    bucket.push(f);
    map.set(f.severity, bucket);
  }
  return map;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  return {
    critical: findings.filter((f) => f.severity === 'critical').length,
    high: findings.filter((f) => f.severity === 'high').length,
    medium: findings.filter((f) => f.severity === 'medium').length,
    low: findings.filter((f) => f.severity === 'low').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
