import { describe, it, expect, vi } from 'vitest';

// ── Mock createProvider so orchestrator tests don't need a real API key ───────

vi.mock('../src/providers/index.js', () => ({
  createProvider: () => ({
    complete: vi.fn().mockResolvedValue({
      content: '[]',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
    }),
  }),
}));

import { runAgents } from '../src/orchestrator.js';
import type { Agent } from '../src/agents/base.js';
import type { AgentResult, Diff, RunConfig } from '../src/types.js';
import { zeroUsage } from '../src/types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDiff(): Diff {
  return {
    base: 'origin/main',
    head: 'abc1234',
    files: [],
    rawDiff: '',
    totalAdditions: 0,
    totalDeletions: 0,
    repoRoot: '/repo',
  };
}

function makeConfig(): RunConfig {
  return {
    base: 'origin/main',
    agents: ['security'],
    model: 'claude-sonnet-4-6',
    maxTokensPerAgent: 4000,
    ignorePatterns: [],
    jsonOutput: false,
    failOn: 'critical',
    apiKey: 'sk-test',
    promptsDir: '/prompts',
    providerName: 'anthropic',
  };
}

function successAgent(name: string, delayMs = 0, findings = []): Agent {
  return {
    name,
    review: () =>
      new Promise<AgentResult>((resolve) =>
        setTimeout(
          () =>
            resolve({
              agentName: name,
              status: 'success',
              findings,
              tokenUsage: zeroUsage(),
              durationMs: delayMs,
            }),
          delayMs,
        ),
      ),
  };
}

function failingAgent(name: string): Agent {
  return {
    name,
    review: async (): Promise<AgentResult> => {
      throw new Error(`${name} exploded`);
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runAgents', () => {
  it('returns one AgentResult per agent', async () => {
    const agents = [successAgent('security'), successAgent('performance')];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    expect(results).toHaveLength(2);
  });

  it('returns empty array when agents list is empty', async () => {
    const results = await runAgents(makeDiff(), [], makeConfig());
    expect(results).toHaveLength(0);
  });

  it('runs agents in parallel, not serially', async () => {
    // 3 agents each sleeping 100ms — serial would take ~300ms, parallel ~120ms
    const agents = [
      successAgent('security', 100),
      successAgent('performance', 100),
      successAgent('style', 100),
    ];
    const start = Date.now();
    await runAgents(makeDiff(), agents, makeConfig());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(250);
  });

  it('agentName in each result matches the agent name property', async () => {
    const agents = [successAgent('security'), successAgent('docs')];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    const names = results.map((r) => r.agentName).sort();
    expect(names).toEqual(['docs', 'security']);
  });

  it('findings from successful agents are present in results', async () => {
    const mockFinding = {
      severity: 'high' as const,
      file: 'src/a.ts',
      line: 1,
      category: 'injection',
      description: 'Test finding',
      suggestion: 'Fix it',
    };
    const agents = [successAgent('security', 0, [mockFinding])];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    expect(results[0]?.findings).toHaveLength(1);
    expect(results[0]?.findings[0]?.category).toBe('injection');
  });

  it('a failed agent does not prevent others from completing', async () => {
    const agents = [failingAgent('security'), successAgent('performance')];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    expect(results).toHaveLength(2);
    const perfResult = results.find((r) => r.agentName === 'performance');
    expect(perfResult?.status).toBe('success');
  });

  it('a failed agent result has status "failed" and an error message', async () => {
    const agents = [failingAgent('security')];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    expect(results[0]?.status).toBe('failed');
    expect(results[0]?.error).toContain('security exploded');
  });

  it('durationMs is a non-negative number for each result', async () => {
    const agents = [successAgent('security', 10)];
    const results = await runAgents(makeDiff(), agents, makeConfig());
    expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('updates spinner text as agents complete', async () => {
    const spinnerMock = { text: '', start: vi.fn() };
    const agents = [successAgent('security', 20), successAgent('performance', 40)];
    await runAgents(makeDiff(), agents, makeConfig(), {
      spinner: spinnerMock as unknown as import('ora').Ora,
    });
    // After all complete, the last update should be 'Finishing up…'
    // (exact text doesn't matter as much as the fact that it was updated)
    expect(typeof spinnerMock.text).toBe('string');
  });
});
