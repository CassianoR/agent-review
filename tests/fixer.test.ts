/**
 * Tests for src/fixer.ts — applyFixes()
 *
 * The redesigned fixer groups findings by file and makes one API call per file
 * (processing files in parallel). FixResult is now file-level, not finding-level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// ── Mock fs/promises ──────────────────────────────────────────────────────────

const mockReadFile  = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({ readFile: mockReadFile, writeFile: mockWriteFile }));
vi.mock('node:fs', () => ({ existsSync: mockExistsSync }));

// ── Mock provider (plain function — not vi.fn — so mockReset doesn't wipe it) ─

const mockComplete = vi.hoisted(() => vi.fn());

vi.mock('../src/providers/index.js', () => ({
  createProvider: () => ({ complete: mockComplete }),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import { applyFixes } from '../src/fixer.js';
import type { Finding, RunConfig } from '../src/types.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const REPO_ROOT = '/repo';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'low',
    file: 'src/utils.ts',
    line: 10,
    category: 'style',
    description: 'Variable name is unclear',
    suggestion: 'Rename `x` to `itemCount`',
    ...overrides,
  };
}

const BASE_CONFIG: RunConfig = {
  base: 'origin/main',
  agents: ['style'],
  model: 'claude-sonnet-4-6',
  maxTokensPerAgent: 4000,
  ignorePatterns: [],
  jsonOutput: false,
  failOn: 'critical',
  apiKey: 'sk-ant-test',
  promptsDir: '/prompts',
  providerName: 'anthropic',
};

function makeProviderResponse(content: string) {
  return {
    content,
    usage: {
      inputTokens: 100, outputTokens: 200,
      cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0.001,
    },
  };
}

// Note: extractFixedFile calls .trim() on the matched block, so no trailing newline.
const ORIGINAL_CONTENT = `function foo(x: number) {\n  return x + 1;\n}`;
const FIXED_CONTENT    = `function foo(itemCount: number) {\n  return itemCount + 1;\n}`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyFixes', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(ORIGINAL_CONTENT);
    mockWriteFile.mockResolvedValue(undefined);
    mockComplete.mockResolvedValue(makeProviderResponse(`\`\`\`fix\n${FIXED_CONTENT}\`\`\``));
  });

  // ── Eligibility filtering ─────────────────────────────────────────────────

  it('returns empty array when there are no eligible findings', async () => {
    const results = await applyFixes([], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('skips critical findings regardless of maxSeverity', async () => {
    const finding = makeFinding({ severity: 'critical' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('skips high findings regardless of maxSeverity', async () => {
    const finding = makeFinding({ severity: 'high' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('excludes medium findings when maxSeverity is "low"', async () => {
    const finding = makeFinding({ severity: 'medium' });
    const results = await applyFixes([finding], BASE_CONFIG, {
      repoRoot: REPO_ROOT,
      maxSeverity: 'low',
    });
    expect(results).toHaveLength(0);
  });

  // ── File-level grouping ───────────────────────────────────────────────────

  it('returns one FixResult per file, not per finding', async () => {
    // Two findings in the same file → one API call → one FixResult
    const findings = [
      makeFinding({ file: 'src/a.ts', category: 'naming' }),
      makeFinding({ file: 'src/a.ts', category: 'complexity' }),
    ];
    const results = await applyFixes(findings, BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(1);
    expect(results[0]!.findings).toHaveLength(2);
  });

  it('groups findings by file and makes one API call per file', async () => {
    const findings = [
      makeFinding({ file: 'src/a.ts' }),
      makeFinding({ file: 'src/a.ts' }),
      makeFinding({ file: 'src/b.ts' }),
    ];
    await applyFixes(findings, BASE_CONFIG, { repoRoot: REPO_ROOT });
    // Two files → two API calls
    expect(mockComplete).toHaveBeenCalledTimes(2);
  });

  it('processes files in parallel (total time ≈ slowest file, not sum)', async () => {
    const delay = (ms: number) =>
      new Promise<typeof makeProviderResponse extends (...args: any[]) => infer R ? R : never>(
        (resolve) => setTimeout(() => resolve(makeProviderResponse(`\`\`\`fix\n${FIXED_CONTENT}\`\`\``)), ms),
      );

    mockComplete
      .mockImplementationOnce(() => delay(80))
      .mockImplementationOnce(() => delay(80));

    const findings = [
      makeFinding({ file: 'src/a.ts' }),
      makeFinding({ file: 'src/b.ts' }),
    ];
    const start = Date.now();
    await applyFixes(findings, BASE_CONFIG, { repoRoot: REPO_ROOT });
    const elapsed = Date.now() - start;

    // Serial would take ~160ms; parallel should finish in ~120ms
    expect(elapsed).toBeLessThan(150);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('applies fix and returns status "applied"', async () => {
    const results = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('applied');
  });

  it('writes the patched content to disk', async () => {
    const finding = makeFinding();
    await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(mockWriteFile).toHaveBeenCalledWith(
      join(REPO_ROOT, finding.file),
      FIXED_CONTENT,
      'utf-8',
    );
  });

  it('returns originalContent and patchedContent in the result', async () => {
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.originalContent).toBe(ORIGINAL_CONTENT);
    expect(result!.patchedContent).toBe(FIXED_CONTENT);
  });

  it('populates linesAdded and linesRemoved from the unified diff', async () => {
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.linesAdded).toBeGreaterThanOrEqual(0);
    expect(result!.linesRemoved).toBeGreaterThanOrEqual(0);
  });

  it('includes a unified diff (patch) string in applied results', async () => {
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.patch).toContain('---');
    expect(result!.patch).toContain('+++');
  });

  // ── Dry-run mode ──────────────────────────────────────────────────────────

  it('does NOT write to disk in dry-run mode', async () => {
    await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT, dryRun: true });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('still returns "applied" status and a patch in dry-run mode', async () => {
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, {
      repoRoot: REPO_ROOT,
      dryRun: true,
    });
    expect(result!.status).toBe('applied');
    expect(result!.patch).toBeTruthy();
  });

  // ── Skip conditions ───────────────────────────────────────────────────────

  it('reports "skipped" when model returns unchanged content', async () => {
    mockComplete.mockResolvedValue(makeProviderResponse(`\`\`\`fix\n${ORIGINAL_CONTENT}\`\`\``));
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('skipped');
    expect(result!.reason).toMatch(/unchanged/i);
  });

  it('reports "skipped" when model responds with SKIP: and preserves the reason', async () => {
    mockComplete.mockResolvedValue(
      makeProviderResponse('```fix\nSKIP: Renaming this would break the public API\n```'),
    );
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('skipped');
    expect(result!.reason).toMatch(/public API/i);
  });

  it('reports "skipped" when file does not exist on disk', async () => {
    mockExistsSync.mockReturnValue(false);
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('skipped');
    expect(result!.reason).toMatch(/does not exist/i);
  });

  it('reports "skipped" with sanity-check reason when model truncates the file', async () => {
    // Return only 1 line for a file that originally had many — triggers the >50% reduction guard
    mockReadFile.mockResolvedValue('line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10');
    mockComplete.mockResolvedValue(makeProviderResponse('```fix\nshort\n```'));
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('skipped');
    expect(result!.reason).toMatch(/shrank/i);
  });

  // ── Failure conditions ────────────────────────────────────────────────────

  it('reports "failed" when readFile throws', async () => {
    mockReadFile.mockRejectedValue(new Error('permission denied'));
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('failed');
    expect(result!.reason).toMatch(/Could not read file/i);
  });

  it('reports "failed" when provider.complete throws', async () => {
    mockComplete.mockRejectedValue(new Error('rate limit exceeded'));
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('failed');
    expect(result!.reason).toMatch(/API call failed/i);
  });

  it('reports "failed" when writeFile throws', async () => {
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    const [result] = await applyFixes([makeFinding()], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(result!.status).toBe('failed');
    expect(result!.reason).toMatch(/Could not write file/i);
  });

  // ── Isolation ─────────────────────────────────────────────────────────────

  it('isolates failures per file — other files still get processed', async () => {
    const findings = [
      makeFinding({ file: 'src/missing.ts' }),  // will be skipped (no file)
      makeFinding({ file: 'src/ok.ts' }),        // will succeed
    ];

    mockExistsSync.mockImplementation((p: string) => !p.includes('missing'));

    const results = await applyFixes(findings, BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(2);

    const missing = results.find((r) => r.relPath === 'src/missing.ts');
    const ok      = results.find((r) => r.relPath === 'src/ok.ts');
    expect(missing?.status).toBe('skipped');
    expect(ok?.status).toBe('applied');
  });
});
