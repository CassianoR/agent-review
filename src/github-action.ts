/**
 * GitHub Action entry point.
 *
 * Runs agentreview against the PR diff and posts findings as inline review
 * comments via the GitHub REST API. Designed to run as a GitHub Action
 * (runs.using: node20), not as a general CLI command.
 *
 * Environment variables injected by the Actions runner:
 *   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA,
 *   GITHUB_BASE_REF, GITHUB_HEAD_REF, GITHUB_EVENT_PATH
 */
import { writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfig } from './config.js';
import { findGitRoot, computeDiff } from './git/diff.js';
import { buildAgents } from './agents/index.js';
import { runAgents } from './orchestrator.js';
import { synthesize } from './synthesizer.js';
import { renderJson } from './reporter.js';
import type { Finding, ReviewReport } from './types.js';
import { SEVERITY_ORDER } from './types.js';

// ── GitHub Actions core helpers (no @actions/core dependency) ─────────────────

function getInput(name: string, fallback = ''): string {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? fallback;
}

function setOutput(name: string, value: string): void {
  // GitHub Actions output format: write to $GITHUB_OUTPUT file
  const outputFile = process.env['GITHUB_OUTPUT'];
  if (outputFile) {
    // Fire-and-forget append — errors are non-fatal for output setting
    appendFile(outputFile, `${name}=${value}\n`).catch(() => {
      console.log(`::set-output name=${name}::${value}`);
    });
  } else {
    console.log(`::set-output name=${name}::${value}`);
  }
}

function info(msg: string): void { console.log(msg); }
function warning(msg: string): void { console.log(`::warning::${msg}`); }
function error(msg: string): void { console.log(`::error::${msg}`); }
function startGroup(title: string): void { console.log(`::group::${title}`); }
function endGroup(): void { console.log('::endgroup::'); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cwd = process.env['GITHUB_WORKSPACE'] ?? process.cwd();
  const anthropicKey = getInput('anthropic-api-key');
  const openaiKey = getInput('openai-api-key');
  const provider = getInput('provider', 'anthropic');
  const agents = getInput('agents', 'security,performance,style,tests,docs');
  const baseRefInput = getInput('base-ref');
  const model = getInput('model', 'claude-sonnet-4-6');
  const failOn = getInput('fail-on', 'critical');
  const postComments = getInput('post-comments', 'true') === 'true';
  const githubToken = getInput('github-token');

  // Inject credentials so resolveConfig can pick them up
  if (anthropicKey) process.env['ANTHROPIC_API_KEY'] = anthropicKey;
  if (openaiKey) process.env['OPENAI_API_KEY'] = openaiKey;
  if (model) process.env['AGENTREVIEW_MODEL'] = model;
  if (provider) process.env['AGENTREVIEW_PROVIDER'] = provider;

  // Resolve base ref: prefer explicit input, then PR base branch, then origin/main
  const baseRef =
    baseRefInput ||
    (process.env['GITHUB_BASE_REF'] ? `origin/${process.env['GITHUB_BASE_REF']}` : 'origin/main');

  startGroup('agentreview configuration');
  info(`Provider: ${provider}`);
  info(`Model: ${model}`);
  info(`Base ref: ${baseRef}`);
  info(`Agents: ${agents}`);
  endGroup();

  let report: ReviewReport;
  try {
    const config = await resolveConfig(cwd, {
      base: baseRef,
      agents,
      failOn,
      provider,
    });

    const gitRoot = await findGitRoot(cwd);
    const diff = await computeDiff(config.base, gitRoot);

    if (diff.files.length === 0) {
      info('No changed files detected — skipping review.');
      setOutput('findings-count', '0');
      setOutput('has-critical', 'false');
      return;
    }

    startGroup(`Running ${config.agents.length} agents`);
    const agentInstances = buildAgents(config.agents);
    const agentResults = await runAgents(diff, agentInstances, config);
    for (const r of agentResults) {
      info(`  ${r.status === 'success' ? '✓' : '✗'} ${r.agentName}: ${r.findings.length} findings`);
    }
    endGroup();

    startGroup('Synthesizing findings');
    report = await synthesize(agentResults, diff, config);
    info(`Total unique findings: ${report.findings.length}`);
    endGroup();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Write JSON report artifact
  const reportPath = join(cwd, 'agentreview-report.json');
  await writeFile(reportPath, renderJson(report), 'utf-8');
  setOutput('report-json', reportPath);
  setOutput('findings-count', String(report.findings.length));
  setOutput('has-critical', String(report.hasCritical));

  // Post PR comments
  if (postComments && githubToken && report.findings.length > 0) {
    await postPrComments(report.findings, githubToken);
  }

  // Exit code
  if (failOn !== 'never') {
    const threshold = SEVERITY_ORDER[failOn as keyof typeof SEVERITY_ORDER];
    if (threshold !== undefined) {
      const blocking = report.findings.filter((f) => SEVERITY_ORDER[f.severity] <= threshold);
      if (blocking.length > 0) {
        error(`${blocking.length} finding(s) at or above "${failOn}" severity — failing the action.`);
        process.exit(1);
      }
    }
  }
}

// ── PR comment posting ────────────────────────────────────────────────────────

async function postPrComments(findings: Finding[], token: string): Promise<void> {
  const repo = process.env['GITHUB_REPOSITORY'];
  const sha = process.env['GITHUB_SHA'];
  const eventPath = process.env['GITHUB_EVENT_PATH'];

  if (!repo || !sha || !eventPath) {
    warning('Missing GITHUB_REPOSITORY / GITHUB_SHA / GITHUB_EVENT_PATH — skipping comments.');
    return;
  }

  let prNumber: number | undefined;
  try {
    const { readFileSync } = await import('node:fs');
    const event = JSON.parse(readFileSync(eventPath, 'utf-8')) as { pull_request?: { number: number } };
    prNumber = event.pull_request?.number;
  } catch {
    warning('Could not read GitHub event payload — skipping comments.');
    return;
  }

  if (!prNumber) {
    warning('No pull_request in event payload — skipping comments. (Is this a PR event?)');
    return;
  }

  startGroup('Posting PR review comments');

  // Post a single review with all findings as comments
  const reviewComments = findings
    .filter((f) => f.line !== null)
    .map((f) => ({
      path: f.file,
      line: f.line as number,
      side: 'RIGHT',
      body: formatComment(f),
    }));

  const reviewBody = formatReviewSummary(findings);

  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
  const payload = {
    commit_id: sha,
    body: reviewBody,
    event: 'COMMENT',
    comments: reviewComments,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agentreview/0.1.0',
    },
    body: JSON.stringify(payload),
  });

  if (response.ok) {
    info(`✓ Posted review with ${reviewComments.length} inline comments`);
  } else {
    const text = await response.text();
    warning(`Failed to post review (HTTP ${response.status}): ${text}`);
  }

  endGroup();
}

const SEV_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  info: 'ℹ️',
};

function formatComment(f: Finding): string {
  const emoji = SEV_EMOJI[f.severity] ?? '•';
  return [
    `${emoji} **[${f.severity.toUpperCase()}]** ${f.category}`,
    ``,
    f.description,
    ``,
    `> **Suggestion:** ${f.suggestion}`,
    ``,
    `<sub>Generated by [agentreview](https://github.com/YOUR_GITHUB_USERNAME/agentreview)</sub>`,
  ].join('\n');
}

function formatReviewSummary(findings: Finding[]): string {
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    '## 🤖 agentreview',
    '',
    `Found **${findings.length}** finding${findings.length !== 1 ? 's' : ''}:`,
    '',
    Object.entries(counts)
      .sort(([a], [b]) => (SEVERITY_ORDER[a as keyof typeof SEVERITY_ORDER] ?? 99) - (SEVERITY_ORDER[b as keyof typeof SEVERITY_ORDER] ?? 99))
      .map(([sev, n]) => `- ${SEV_EMOJI[sev] ?? '•'} **${sev}**: ${n}`)
      .join('\n'),
  ];
  return lines.join('\n');
}

main().catch((err) => {
  error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
