import { z } from 'zod';

// ── Severity ──────────────────────────────────────────────────────────────────

export const SeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type Severity = z.infer<typeof SeveritySchema>;

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

// ── Finding ───────────────────────────────────────────────────────────────────

export const FindingSchema = z.object({
  severity: SeveritySchema,
  file: z.string().min(1),
  line: z.number().int().nonnegative().nullable(),
  category: z.string().min(1),
  description: z.string().min(1),
  suggestion: z.string().min(1),
});
export type Finding = z.infer<typeof FindingSchema>;

export const FindingsArraySchema = z.array(FindingSchema);

// ── Diff ──────────────────────────────────────────────────────────────────────

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface Diff {
  base: string;
  head: string;
  files: DiffFile[];
  rawDiff: string;
  totalAdditions: number;
  totalDeletions: number;
  repoRoot: string;
}

// ── Token usage ───────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

export function zeroUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedCostUsd: a.estimatedCostUsd + b.estimatedCostUsd,
  };
}

// Pricing per million tokens (Anthropic, 2026)
const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-7': { input: 15.0, output: 75.0, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
};

export function computeCost(
  usage: Omit<TokenUsage, 'estimatedCostUsd'>,
  model: string,
): number {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6']!;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

// ── Agent Config ──────────────────────────────────────────────────────────────

export interface AgentConfig {
  model: string;
  maxTokens: number;
  apiKey: string;
  promptsDir: string;
  ignorePatterns: string[];
  /** Injected LLM provider. When omitted, BaseAgent creates an AnthropicProvider. */
  provider?: import('./providers/base.js').LLMProvider;
}

// ── Agent Result ──────────────────────────────────────────────────────────────

export type AgentResultStatus = 'success' | 'failed' | 'skipped';

export interface AgentResult {
  agentName: string;
  status: AgentResultStatus;
  findings: Finding[];
  tokenUsage: TokenUsage;
  error?: string;
  durationMs: number;
}

// ── Run Config ────────────────────────────────────────────────────────────────

export type AgentName =
  | 'security'
  | 'performance'
  | 'style'
  | 'tests'
  | 'docs'
  | 'dependency'
  | 'accessibility'
  | 'i18n';

export const AGENT_NAMES: AgentName[] = [
  'security',
  'performance',
  'style',
  'tests',
  'docs',
  'dependency',
  'accessibility',
  'i18n',
];

export interface RunConfig {
  base: string;
  agents: AgentName[];
  model: string;
  maxTokensPerAgent: number;
  ignorePatterns: string[];
  output?: string;
  jsonOutput: boolean;
  failOn: Severity | 'never';
  apiKey: string;
  promptsDir: string;
  /** Which LLM backend to use. Defaults to 'anthropic'. */
  providerName: import('./providers/base.js').ProviderName;
  /** OpenAI API key — only required when providerName is 'openai'. */
  openaiApiKey?: string;
}

// ── Review Report ─────────────────────────────────────────────────────────────

export interface ReviewReport {
  summary: string;
  findings: Finding[];
  agentResults: AgentResult[];
  totalUsage: TokenUsage;
  hasCritical: boolean;
  markdownBody: string;
  generatedAt: string;
}
