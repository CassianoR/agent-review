import type { Ora } from 'ora';
import type { Agent } from './agents/base.js';
import type { AgentConfig, AgentResult, Diff, RunConfig } from './types.js';
import { zeroUsage } from './types.js';
import { createProvider } from './providers/index.js';

export interface OrchestratorOptions {
  /** If provided, the spinner text is updated as agents complete. */
  spinner?: Ora;
}

export async function runAgents(
  diff: Diff,
  agents: Agent[],
  config: RunConfig,
  opts: OrchestratorOptions = {},
): Promise<AgentResult[]> {
  if (agents.length === 0) return [];

  const provider = createProvider(config.providerName, {
    anthropicApiKey: config.apiKey,
    openaiApiKey: config.openaiApiKey,
    model: config.model,
  });

  const agentConfig: AgentConfig = {
    model: config.model,
    maxTokens: config.maxTokensPerAgent,
    apiKey: config.apiKey,
    promptsDir: config.promptsDir,
    ignorePatterns: config.ignorePatterns,
    provider,
  };

  // Track which agents are still running so the spinner shows live status
  const running = new Set(agents.map((a) => a.name));

  const promises = agents.map(async (agent): Promise<AgentResult> => {
    try {
      const result = await agent.review(diff, agentConfig);
      running.delete(agent.name);
      if (opts.spinner) {
        opts.spinner.text =
          running.size > 0
            ? `Running: ${[...running].join(', ')}…`
            : 'Finishing up…';
      }
      return result;
    } catch (err) {
      // BaseAgent.review() already catches internally, but defend against
      // broken custom agents that don't extend BaseAgent.
      running.delete(agent.name);
      return {
        agentName: agent.name,
        status: 'failed',
        findings: [],
        tokenUsage: zeroUsage(),
        error: err instanceof Error ? err.message : String(err),
        durationMs: 0,
      };
    }
  });

  // Promise.allSettled: never throws — all agents run regardless of failures
  const settled = await Promise.allSettled(promises);

  const results: AgentResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      // A Promise itself rejected — shouldn't happen with our wrapper
      results.push({
        agentName: 'unknown',
        status: 'failed',
        findings: [],
        tokenUsage: zeroUsage(),
        error:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        durationMs: 0,
      });
    }
  }

  return results;
}
