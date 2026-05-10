import type { AgentName } from '../types.js';
import type { Agent } from './base.js';
import { SecurityAgent } from './security.js';
import { PerformanceAgent } from './performance.js';
import { StyleAgent } from './style.js';
import { TestsAgent } from './tests.js';
import { DocsAgent } from './docs.js';
import { DependencyAgent } from './dependency.js';
import { AccessibilityAgent } from './accessibility.js';
import { I18nAgent } from './i18n.js';

const AGENT_REGISTRY: Record<AgentName, () => Agent> = {
  security: () => new SecurityAgent(),
  performance: () => new PerformanceAgent(),
  style: () => new StyleAgent(),
  tests: () => new TestsAgent(),
  docs: () => new DocsAgent(),
  dependency: () => new DependencyAgent(),
  accessibility: () => new AccessibilityAgent(),
  i18n: () => new I18nAgent(),
};

export function buildAgents(names: AgentName[]): Agent[] {
  return names.map((n) => AGENT_REGISTRY[n]());
}
