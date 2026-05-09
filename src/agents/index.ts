import type { AgentName } from '../types.js';
import type { Agent } from './base.js';
import { SecurityAgent } from './security.js';
import { PerformanceAgent } from './performance.js';
import { StyleAgent } from './style.js';
import { TestsAgent } from './tests.js';
import { DocsAgent } from './docs.js';

const AGENT_REGISTRY: Record<AgentName, () => Agent> = {
  security: () => new SecurityAgent(),
  performance: () => new PerformanceAgent(),
  style: () => new StyleAgent(),
  tests: () => new TestsAgent(),
  docs: () => new DocsAgent(),
};

export function buildAgents(names: AgentName[]): Agent[] {
  return names.map((n) => AGENT_REGISTRY[n]());
}
