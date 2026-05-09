import { describe, it, expect, vi, beforeEach } from 'vitest';
import { filterDiff, buildUserMessage, parseFindings } from '../../src/agents/base.js';
import type { Diff } from '../../src/types.js';

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeDiff(overrides: Partial<Diff> = {}): Diff {
  return {
    base: 'origin/main',
    head: 'abc1234',
    files: [
      {
        path: 'src/foo.ts',
        status: 'modified',
        patch: '+const x = 1;\n-const x = 0;',
        additions: 1,
        deletions: 1,
      },
      {
        path: 'package-lock.json',
        status: 'modified',
        patch: '+  "version": "2.0.0"',
        additions: 1,
        deletions: 0,
      },
    ],
    rawDiff: '+const x = 1;\n-const x = 0;\n+  "version": "2.0.0"',
    totalAdditions: 2,
    totalDeletions: 1,
    repoRoot: '/repo',
    ...overrides,
  };
}

// ── filterDiff ────────────────────────────────────────────────────────────────

describe('filterDiff', () => {
  it('returns original diff when ignorePatterns is empty', () => {
    const diff = makeDiff();
    const result = filterDiff(diff, []);
    expect(result).toBe(diff); // same reference
  });

  it('removes files matching ignore patterns', () => {
    const diff = makeDiff();
    const result = filterDiff(diff, ['**/*.lock', '**/package-lock.json']);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe('src/foo.ts');
  });

  it('keeps all files when no patterns match', () => {
    const diff = makeDiff();
    const result = filterDiff(diff, ['**/dist/**']);
    expect(result.files).toHaveLength(2);
  });

  it('recalculates totalAdditions after filtering', () => {
    const diff = makeDiff();
    const result = filterDiff(diff, ['**/package-lock.json']);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });
});

// ── buildUserMessage ──────────────────────────────────────────────────────────

describe('buildUserMessage', () => {
  it('includes base and head in the message', () => {
    const diff = makeDiff();
    const msg = buildUserMessage(diff);
    expect(msg).toContain('origin/main');
    expect(msg).toContain('abc1234');
  });

  it('includes a diff code block', () => {
    const diff = makeDiff();
    const msg = buildUserMessage(diff);
    expect(msg).toContain('```diff');
    expect(msg).toContain('```');
  });

  it('adds truncation warning for diffs over 150k chars', () => {
    const bigRawDiff = 'x'.repeat(160_000);
    const diff = makeDiff({ rawDiff: bigRawDiff });
    const msg = buildUserMessage(diff);
    expect(msg).toContain('truncated');
  });

  it('does not add truncation warning for normal diffs', () => {
    const diff = makeDiff();
    const msg = buildUserMessage(diff);
    expect(msg).not.toContain('truncated');
  });
});

// ── parseFindings ─────────────────────────────────────────────────────────────

const VALID_FINDINGS_JSON = `\`\`\`json
[
  {
    "severity": "high",
    "file": "src/auth.ts",
    "line": 10,
    "category": "injection",
    "description": "SQL injection vulnerability",
    "suggestion": "Use parameterized queries"
  }
]
\`\`\``;

const EMPTY_FINDINGS_JSON = '```json\n[]\n```';

describe('parseFindings', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('parses valid JSON code block and returns Finding[]', () => {
    const findings = parseFindings(VALID_FINDINGS_JSON, 'security');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('high');
    expect(findings[0]?.category).toBe('injection');
  });

  it('returns empty array for empty JSON array', () => {
    const findings = parseFindings(EMPTY_FINDINGS_JSON, 'security');
    expect(findings).toHaveLength(0);
  });

  it('warns and returns [] for malformed JSON', () => {
    const findings = parseFindings('```json\n[BROKEN\n```', 'security');
    expect(findings).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not parse JSON'),
    );
  });

  it('warns and does partial recovery for array with some invalid items', () => {
    const mixed = `\`\`\`json
[
  {
    "severity": "high",
    "file": "src/a.ts",
    "line": 1,
    "category": "injection",
    "description": "Valid finding",
    "suggestion": "Fix it"
  },
  {
    "severity": "INVALID_SEVERITY",
    "file": "src/b.ts",
    "line": 2,
    "category": "style",
    "description": "Bad severity",
    "suggestion": "Fix it too"
  }
]
\`\`\``;
    const findings = parseFindings(mixed, 'security');
    // Only the valid item should survive
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('src/a.ts');
    expect(console.warn).toHaveBeenCalled();
  });

  it('accepts bare JSON without code fences', () => {
    const bare = JSON.stringify([
      {
        severity: 'low',
        file: 'src/x.ts',
        line: null,
        category: 'style',
        description: 'Minor issue',
        suggestion: 'Clean up',
      },
    ]);
    const findings = parseFindings(bare, 'style');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('low');
  });
});
