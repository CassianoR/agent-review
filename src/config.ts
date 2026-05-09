import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentName, RunConfig, Severity } from './types.js';
import { AGENT_NAMES } from './types.js';

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  base: 'origin/main',
  agents: ['security', 'performance', 'style', 'tests', 'docs'] as AgentName[],
  model: 'claude-sonnet-4-6',
  maxTokensPerAgent: 4000,
  ignorePatterns: ['**/*.lock', '**/dist/**', '**/node_modules/**', '**/*.min.js'],
  jsonOutput: false,
  failOn: 'critical' as Severity | 'never',
} as const;

// ── RC file shape ─────────────────────────────────────────────────────────────

interface RcFile {
  base?: string;
  agents?: string[];
  model?: string;
  maxTokensPerAgent?: number;
  ignorePatterns?: string[];
}

export interface CliFlags {
  base?: string;
  agents?: string;
  output?: string;
  json?: boolean;
  failOn?: string;
}

// ── RC discovery ──────────────────────────────────────────────────────────────

async function findRcFile(startDir: string): Promise<RcFile | null> {
  let current = startDir;
  while (true) {
    const candidate = join(current, '.agentreviewrc');
    if (existsSync(candidate)) {
      const text = await readFile(candidate, 'utf-8');
      return JSON.parse(text) as RcFile;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ── Prompts directory resolution ──────────────────────────────────────────────

export function resolvePromptsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/config.ts → src/ → project root → prompts/
  const pkgRoot = join(dirname(thisFile), '..');
  return join(pkgRoot, 'prompts');
}

// ── Main merge ────────────────────────────────────────────────────────────────

export async function resolveConfig(cwd: string, flags: CliFlags): Promise<RunConfig> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY environment variable is not set.\n' +
        'Export it before running: export ANTHROPIC_API_KEY=sk-ant-...',
    );
  }

  const rc = (await findRcFile(cwd)) ?? {};

  const agentsRaw = flags.agents ?? rc.agents?.join(',') ?? DEFAULTS.agents.join(',');

  return {
    base: flags.base ?? rc.base ?? DEFAULTS.base,
    agents: parseAgentList(agentsRaw),
    model: process.env['AGENTREVIEW_MODEL'] ?? rc.model ?? DEFAULTS.model,
    maxTokensPerAgent: rc.maxTokensPerAgent ?? DEFAULTS.maxTokensPerAgent,
    ignorePatterns: rc.ignorePatterns ?? [...DEFAULTS.ignorePatterns],
    output: flags.output,
    jsonOutput: flags.json ?? DEFAULTS.jsonOutput,
    failOn: (flags.failOn as Severity | 'never') ?? DEFAULTS.failOn,
    apiKey,
    promptsDir: resolvePromptsDir(),
  };
}

function parseAgentList(raw: string): AgentName[] {
  const names = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = names.filter((n): n is AgentName => (AGENT_NAMES as string[]).includes(n));
  if (valid.length === 0) throw new Error(`No valid agent names found in: "${raw}"`);
  return valid;
}

export const RC_TEMPLATE = JSON.stringify(
  {
    base: 'origin/main',
    agents: ['security', 'performance', 'style', 'tests'],
    model: 'claude-sonnet-4-6',
    maxTokensPerAgent: 4000,
    ignorePatterns: ['**/*.lock', '**/dist/**'],
  },
  null,
  2,
);
