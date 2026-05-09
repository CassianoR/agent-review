import { describe, it, expect } from 'vitest';
import {
  renderJson,
  buildMarkdownFromScratch,
  buildSummaryTable,
  buildUsageTable,
} from '../src/reporter.js';
import type { ReviewReport, Finding } from '../src/types.js';
import { zeroUsage } from '../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeFindings(): Finding[] {
  return [
    {
      severity: 'critical',
      file: 'src/auth.ts',
      line: 10,
      category: 'injection',
      description: 'SQL injection',
      suggestion: 'Use parameterized queries',
    },
    {
      severity: 'medium',
      file: 'src/utils.ts',
      line: 5,
      category: 'type-safety',
      description: 'any type',
      suggestion: 'Use unknown',
    },
    {
      severity: 'low',
      file: 'src/config.ts',
      line: null,
      category: 'missing-jsdoc',
      description: 'No JSDoc',
      suggestion: 'Add JSDoc',
    },
  ];
}

function makeReport(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    summary: 'Test summary.',
    findings: makeFindings(),
    agentResults: [
      {
        agentName: 'security',
        status: 'success',
        findings: makeFindings().slice(0, 1),
        tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001 },
        durationMs: 200,
      },
      {
        agentName: 'docs',
        status: 'failed',
        findings: [],
        tokenUsage: zeroUsage(),
        error: 'Prompt file missing',
        durationMs: 10,
      },
    ],
    totalUsage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, estimatedCostUsd: 0.0085 },
    hasCritical: true,
    markdownBody: '# Code Review Report\n\nSynth output here.',
    generatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── renderJson ────────────────────────────────────────────────────────────────

describe('renderJson', () => {
  it('omits markdownBody from JSON output', () => {
    const json = renderJson(makeReport());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('markdownBody');
  });

  it('includes findings, summary, and totalUsage in JSON output', () => {
    const json = renderJson(makeReport());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toHaveProperty('findings');
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('totalUsage');
    expect(parsed).toHaveProperty('hasCritical', true);
  });
});

// ── buildMarkdownFromScratch ──────────────────────────────────────────────────

describe('buildMarkdownFromScratch', () => {
  it('includes severity sections for findings that exist', () => {
    const md = buildMarkdownFromScratch(makeReport());
    expect(md).toContain('Critical');
    expect(md).toContain('Medium');
    expect(md).toContain('Low');
  });

  it('omits severity sections with zero findings', () => {
    const report = makeReport({ findings: makeFindings().slice(0, 1) }); // only critical
    const md = buildMarkdownFromScratch(report);
    expect(md).toContain('Critical');
    expect(md).not.toContain('### 🟡 Medium');
    expect(md).not.toContain('### 🟢 Low');
  });

  it('includes the token usage table', () => {
    const md = buildMarkdownFromScratch(makeReport());
    expect(md).toContain('Token Usage');
    expect(md).toContain('$0.0085');
  });

  it('includes agent results table with error column', () => {
    const md = buildMarkdownFromScratch(makeReport());
    expect(md).toContain('Agent Results');
    expect(md).toContain('Prompt file missing');
    expect(md).toContain('❌');
    expect(md).toContain('✅');
  });
});

// ── buildSummaryTable ─────────────────────────────────────────────────────────

describe('buildSummaryTable', () => {
  it('correctly counts findings per severity', () => {
    const table = buildSummaryTable(makeFindings());
    expect(table).toContain('| 🔴 Critical | 1 |');
    expect(table).toContain('| 🟡 Medium   | 1 |');
    expect(table).toContain('| 🟢 Low      | 1 |');
    expect(table).toContain('| **Total**   | **3** |');
  });
});

// ── buildUsageTable ───────────────────────────────────────────────────────────

describe('buildUsageTable', () => {
  it('renders all token fields and cost', () => {
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50, estimatedCostUsd: 0.0085 };
    const table = buildUsageTable(usage);
    expect(table).toContain('1,000');
    expect(table).toContain('500');
    expect(table).toContain('200');
    expect(table).toContain('$0.0085');
  });
});
