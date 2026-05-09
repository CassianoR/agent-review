import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFindings, extractSummary } from '../src/synthesizer.js';
import type { AgentResult, Diff, Finding, RunConfig } from '../src/types.js';

// ── Mock the Anthropic SDK ────────────────────────────────────────────────────
// Use vi.hoisted so mockCreate is available before the vi.mock factory runs
// (factories are hoisted to the top of the file). A plain class is used as the
// constructor mock so that mockReset: true (in vitest.config) doesn't wipe the
// constructor's implementation between tests — only mockCreate is a vi.fn().

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
    },
  };
});

// Lazy import synthesize after mocking so it picks up the mock
async function getSynthesize() {
  const mod = await import('../src/synthesizer.js');
  return mod.synthesize;
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/responses');

const SYNTHESIZER_MD = readFileSync(join(FIXTURES_DIR, 'synthesizer-output.md'), 'utf-8');

function makeDiff(): Diff {
  return {
    base: 'origin/main',
    head: 'abc1234',
    files: [],
    rawDiff: '',
    totalAdditions: 5,
    totalDeletions: 2,
    repoRoot: '/repo',
  };
}

function makeConfig(): RunConfig {
  return {
    base: 'origin/main',
    agents: ['security', 'style'],
    model: 'claude-sonnet-4-6',
    maxTokensPerAgent: 4000,
    ignorePatterns: [],
    jsonOutput: false,
    failOn: 'critical',
    apiKey: 'sk-test',
    promptsDir: join(dirname(fileURLToPath(import.meta.url)), '../prompts'),
  };
}

function makeAgentResults(withCritical = true): AgentResult[] {
  const criticalFinding: Finding = {
    severity: 'critical',
    file: 'src/auth/login.ts',
    line: 42,
    category: 'injection',
    description: 'SQL injection',
    suggestion: 'Use parameterized queries',
  };
  const mediumFinding: Finding = {
    severity: 'medium',
    file: 'src/utils/parse.ts',
    line: 15,
    category: 'type-safety',
    description: 'any type',
    suggestion: 'Use unknown',
  };
  return [
    {
      agentName: 'security',
      status: 'success',
      findings: withCritical ? [criticalFinding] : [],
      tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001 },
      durationMs: 200,
    },
    {
      agentName: 'style',
      status: 'success',
      findings: [mediumFinding],
      tokenUsage: { inputTokens: 80, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.0008 },
      durationMs: 180,
    },
  ];
}

function mockApiSuccess(markdown: string): void {
  mockCreate.mockResolvedValueOnce({
    content: [{ type: 'text', text: markdown }],
    usage: { input_tokens: 500, output_tokens: 300 },
  });
}

// ── extractFindings (pure, no API) ────────────────────────────────────────────

describe('extractFindings', () => {
  it('parses FINDINGS_JSON block from synthesizer markdown', () => {
    const findings = extractFindings(SYNTHESIZER_MD, []);
    expect(findings).toHaveLength(3);
    expect(findings[0]?.severity).toBe('critical');
  });

  it('returns findings sorted critical-first', () => {
    const findings = extractFindings(SYNTHESIZER_MD, []);
    const severities = findings.map((f) => f.severity);
    expect(severities).toEqual(['critical', 'critical', 'medium']);
  });

  it('falls back to fallback array when FINDINGS_JSON block is absent', () => {
    const markdownWithoutBlock = '# Code Review Report\n\nNo issues.\n';
    const fallback: Finding[] = [
      { severity: 'low', file: 'src/a.ts', line: 1, category: 'style', description: 'minor', suggestion: 'fix' },
    ];
    const findings = extractFindings(markdownWithoutBlock, fallback);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('low');
  });

  it('falls back when FINDINGS_JSON contains malformed JSON', () => {
    const broken = '<!-- FINDINGS_JSON\n[BROKEN\n-->';
    const fallback: Finding[] = [
      { severity: 'high', file: 'src/b.ts', line: null, category: 'security', description: 'issue', suggestion: 'fix' },
    ];
    const findings = extractFindings(broken, fallback);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
  });
});

// ── extractSummary (pure, no API) ─────────────────────────────────────────────

describe('extractSummary', () => {
  it('extracts the first paragraph after the h1 heading', () => {
    const summary = extractSummary(SYNTHESIZER_MD);
    expect(summary).toContain('SQL injection');
    expect(summary).not.toContain('##');
  });

  it('returns empty string for markdown with no content after h1', () => {
    const markdown = '# Code Review Report\n\n## Summary\n';
    const summary = extractSummary(markdown);
    expect(summary).toBe('');
  });
});

// ── synthesize (integration, mocked API) ─────────────────────────────────────

describe('synthesize', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it('returns ReviewReport with markdownBody from API response', async () => {
    mockApiSuccess(SYNTHESIZER_MD);
    const synthesize = await getSynthesize();
    const report = await synthesize(makeAgentResults(), makeDiff(), makeConfig());
    expect(report.markdownBody).toContain('Code Review Report');
  });

  it('hasCritical is true when findings contain a critical severity', async () => {
    mockApiSuccess(SYNTHESIZER_MD);
    const synthesize = await getSynthesize();
    const report = await synthesize(makeAgentResults(true), makeDiff(), makeConfig());
    expect(report.hasCritical).toBe(true);
  });

  it('hasCritical is false when no critical findings', async () => {
    const noCriticalMd = SYNTHESIZER_MD.replace(
      /<!-- FINDINGS_JSON[\s\S]*?-->/,
      '<!-- FINDINGS_JSON\n[{"severity":"low","file":"src/a.ts","line":1,"category":"style","description":"minor","suggestion":"fix"}]\n-->',
    );
    mockApiSuccess(noCriticalMd);
    const synthesize = await getSynthesize();
    const report = await synthesize(makeAgentResults(false), makeDiff(), makeConfig());
    expect(report.hasCritical).toBe(false);
  });

  it('totalUsage aggregates tokens from all agents plus synthesizer call', async () => {
    mockApiSuccess(SYNTHESIZER_MD);
    const synthesize = await getSynthesize();
    const results = makeAgentResults();
    const report = await synthesize(results, makeDiff(), makeConfig());
    // security: 100+50, style: 80+40, synthesizer: 500+300 = 1070 total tokens
    expect(report.totalUsage.inputTokens).toBe(100 + 80 + 500);
    expect(report.totalUsage.outputTokens).toBe(50 + 40 + 300);
  });

  it('throws when the Anthropic API fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('API rate limit'));
    const synthesize = await getSynthesize();
    await expect(synthesize(makeAgentResults(), makeDiff(), makeConfig())).rejects.toThrow(
      'API rate limit',
    );
  });
});
