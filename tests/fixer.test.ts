/**
 * Tests for src/fixer.ts — applyFixes()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

// ── Mock fs/promises ──────────────────────────────────────────────────────────

const mockReadFile = vi.hoisted(() => vi.fn());
const mockWriteFile = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

// ── Mock provider ─────────────────────────────────────────────────────────────

const mockComplete = vi.hoisted(() => vi.fn());

// Use a plain function (not vi.fn) so mockReset: true doesn't wipe the implementation
vi.mock('../src/providers/index.js', () => ({
  createProvider: () => ({ complete: mockComplete }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

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
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.001,
    },
  };
}

// Note: extractFixedFile calls .trim() on the matched block, stripping trailing newlines.
// These constants intentionally have no trailing newline to match that behavior.
const ORIGINAL_CONTENT = `function foo(x: number) {\n  return x + 1;\n}`;
const FIXED_CONTENT = `function foo(itemCount: number) {\n  return itemCount + 1;\n}`;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('applyFixes', () => {
  beforeEach(() => {
    mockExistsSync.mockReturnValue(true);
    mockReadFile.mockResolvedValue(ORIGINAL_CONTENT);
    mockWriteFile.mockResolvedValue(undefined);
    mockComplete.mockResolvedValue(makeProviderResponse(`\`\`\`fix\n${FIXED_CONTENT}\`\`\``));
  });

  it('returns empty array when no eligible findings', async () => {
    const results = await applyFixes([], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('skips critical findings even when maxSeverity is not set', async () => {
    const finding = makeFinding({ severity: 'critical' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('skips high findings even when maxSeverity is not set', async () => {
    const finding = makeFinding({ severity: 'high' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(0);
  });

  it('applies fix for a low-severity finding', async () => {
    const finding = makeFinding({ severity: 'low' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('applied');
  });

  it('applies fix for an info-severity finding', async () => {
    const finding = makeFinding({ severity: 'info' });
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('applied');
  });

  it('writes the patched content to the file', async () => {
    const finding = makeFinding();
    await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    const expectedPath = join(REPO_ROOT, finding.file);
    expect(mockWriteFile).toHaveBeenCalledWith(expectedPath, FIXED_CONTENT, 'utf-8');
  });

  it('does NOT write to disk in dry-run mode', async () => {
    const finding = makeFinding();
    await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT, dryRun: true });
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('reports "skipped" when model returns unchanged content', async () => {
    mockComplete.mockResolvedValue(
      makeProviderResponse(`\`\`\`fix\n${ORIGINAL_CONTENT}\`\`\``),
    );
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('skipped');
    expect(results[0]!.reason).toMatch(/unchanged/i);
  });

  it('reports "skipped" when model responds with SKIP:', async () => {
    mockComplete.mockResolvedValue(
      makeProviderResponse('```fix\nSKIP: Too risky to change automatically\n```'),
    );
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('skipped');
  });

  it('reports "skipped" when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('skipped');
    expect(results[0]!.reason).toMatch(/does not exist/i);
  });

  it('reports "failed" when readFile throws', async () => {
    mockReadFile.mockRejectedValue(new Error('permission denied'));
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reason).toMatch(/Could not read file/i);
  });

  it('reports "failed" when provider.complete throws', async () => {
    mockComplete.mockRejectedValue(new Error('API error'));
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reason).toMatch(/API call failed/i);
  });

  it('reports "failed" when writeFile throws', async () => {
    mockWriteFile.mockRejectedValue(new Error('disk full'));
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.status).toBe('failed');
    expect(results[0]!.reason).toMatch(/Could not write file/i);
  });

  it('isolates failures — other findings still processed', async () => {
    const failFinding = makeFinding({ file: 'src/bad.ts' });
    const okFinding = makeFinding({ file: 'src/ok.ts' });

    mockExistsSync.mockImplementation((p: string) => !p.includes('bad'));
    const results = await applyFixes([failFinding, okFinding], BASE_CONFIG, { repoRoot: REPO_ROOT });

    expect(results).toHaveLength(2);
    expect(results[0]!.status).toBe('skipped'); // bad.ts file doesn't exist
    expect(results[1]!.status).toBe('applied');  // ok.ts applied successfully
  });

  it('includes originalContent and patchedContent in applied results', async () => {
    const finding = makeFinding();
    const results = await applyFixes([finding], BASE_CONFIG, { repoRoot: REPO_ROOT });
    expect(results[0]!.originalContent).toBe(ORIGINAL_CONTENT);
    expect(results[0]!.patchedContent).toBe(FIXED_CONTENT);
  });

  it('respects maxSeverity option — medium is excluded when maxSeverity is low', async () => {
    const finding = makeFinding({ severity: 'medium' });
    const results = await applyFixes([finding], BASE_CONFIG, {
      repoRoot: REPO_ROOT,
      maxSeverity: 'low',
    });
    // medium has SEVERITY_ORDER 2, low has 3 — medium is above (more critical than) low
    // so it should be excluded
    expect(results).toHaveLength(0);
  });
});
