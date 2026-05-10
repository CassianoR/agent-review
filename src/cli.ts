import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { writeFile, existsSync } from 'node:fs';
import { resolveConfig, RC_TEMPLATE } from './config.js';
import { findGitRoot, computeDiff } from './git/diff.js';
import { buildAgents } from './agents/index.js';
import { runAgents } from './orchestrator.js';
import { synthesize } from './synthesizer.js';
import { renderMarkdown, renderJson, writeReport, buildMarkdownFromScratch } from './reporter.js';
import { applyFixes } from './fixer.js';
import type { Severity } from './types.js';
import { SEVERITY_ORDER } from './types.js';

// ── Severity coloring ─────────────────────────────────────────────────────────

const SEV_COLOR: Record<Severity, (s: string) => string> = {
  critical: chalk.bgRed.white.bold,
  high: chalk.red.bold,
  medium: chalk.yellow.bold,
  low: chalk.cyan,
  info: chalk.gray,
};

const SEV_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
  info: 'ℹ️ ',
};

// ── CLI definition ────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('agentreview')
  .description('Multi-agent AI code review powered by Anthropic Claude')
  .version('0.1.0');

// ── Main review command ───────────────────────────────────────────────────────

program
  .argument('[path]', 'Path to git repo (defaults to current directory)')
  .option('-b, --base <ref>', 'Base git ref to diff against (e.g. origin/main, HEAD~3)')
  .option(
    '-a, --agents <names>',
    'Comma-separated list of agents to run: security,performance,style,tests,docs,dependency,accessibility,i18n',
  )
  .option('-o, --output <file>', 'Also write the report to a file')
  .option('--json', 'Output machine-readable JSON instead of Markdown')
  .option(
    '--fail-on <severity>',
    'Exit with code 1 if any finding meets or exceeds this severity (critical|high|medium|low|never)',
  )
  .option(
    '--provider <name>',
    'LLM backend to use: anthropic (default) or openai',
  )
  .option(
    '--fix',
    'Auto-apply suggestions for low/info severity findings (opt-in, rewrites files)',
  )
  .option(
    '--fix-severity <severity>',
    'Maximum severity to auto-fix when --fix is used (default: low)',
  )
  .action(async (repoArg: string | undefined, flags: Record<string, string | boolean | undefined>) => {
    const cwd = repoArg ?? process.cwd();
    const spinner = ora({ color: 'cyan' });

    try {
      // ── 1. Config ────────────────────────────────────────────────────────
      spinner.start('Resolving configuration…');
      const config = await resolveConfig(cwd, {
        base: flags['base'] as string | undefined,
        agents: flags['agents'] as string | undefined,
        output: flags['output'] as string | undefined,
        json: flags['json'] as boolean | undefined,
        failOn: flags['failOn'] as string | undefined,
        provider: flags['provider'] as string | undefined,
      });
      spinner.succeed(
        `Config: base=${chalk.bold(config.base)}  agents=${chalk.bold(config.agents.join(','))}  model=${chalk.bold(config.model)}  provider=${chalk.bold(config.providerName)}`,
      );

      // ── 2. Git diff ───────────────────────────────────────────────────────
      spinner.start('Computing git diff…');
      const gitRoot = await findGitRoot(cwd);
      const diff = await computeDiff(config.base, gitRoot);

      if (diff.files.length === 0) {
        spinner.warn('No changed files detected — nothing to review.');
        process.exit(0);
      }

      spinner.succeed(
        `Diff: ${chalk.bold(diff.files.length)} files  ${chalk.green(`+${diff.totalAdditions}`)} ${chalk.red(`-${diff.totalDeletions}`)}`,
      );

      // ── 3. Agents (parallel) ──────────────────────────────────────────────
      spinner.start(`Running ${config.agents.length} agents in parallel…`);
      const agents = buildAgents(config.agents);
      const agentResults = await runAgents(diff, agents, config, { spinner });
      spinner.succeed('All agents complete');

      // Per-agent summary line
      for (const r of agentResults) {
        const icon = r.status === 'success' ? chalk.green('✓') : chalk.red('✗');
        const count = r.findings.length;
        const label = `${icon} ${chalk.bold(r.agentName)}: ${count} finding${count !== 1 ? 's' : ''} (${r.durationMs}ms)`;
        console.log(`  ${label}`);
        if (r.error) {
          console.warn(`    ${chalk.red('Error:')} ${r.error}`);
        }

        // Severity breakdown for this agent
        if (count > 0) {
          const bySev = r.findings.reduce<Record<string, number>>((acc, f) => {
            acc[f.severity] = (acc[f.severity] ?? 0) + 1;
            return acc;
          }, {});
          const parts = (['critical', 'high', 'medium', 'low', 'info'] as Severity[])
            .filter((s) => (bySev[s] ?? 0) > 0)
            .map((s) => SEV_COLOR[s](`${SEV_EMOJI[s]} ${bySev[s]} ${s}`));
          console.log(`    ${parts.join('  ')}`);
        }
      }

      // ── 4. Synthesizer ────────────────────────────────────────────────────
      spinner.start('Synthesizing findings with Claude…');
      let report;
      try {
        report = await synthesize(agentResults, diff, config);
        spinner.succeed(
          `Synthesis complete — ${chalk.bold(report.findings.length)} unique finding${report.findings.length !== 1 ? 's' : ''}`,
        );
      } catch (synthErr) {
        spinner.warn(
          `Synthesizer failed: ${synthErr instanceof Error ? synthErr.message : String(synthErr)}`,
        );
        spinner.info('Falling back to raw agent output…');
        // Build a fallback report from raw agent data
        const allFindings = agentResults.flatMap((r) => r.findings);
        const totalUsage = agentResults.reduce(
          (acc, r) => ({
            inputTokens: acc.inputTokens + r.tokenUsage.inputTokens,
            outputTokens: acc.outputTokens + r.tokenUsage.outputTokens,
            cacheReadTokens: acc.cacheReadTokens + r.tokenUsage.cacheReadTokens,
            cacheWriteTokens: acc.cacheWriteTokens + r.tokenUsage.cacheWriteTokens,
            estimatedCostUsd: acc.estimatedCostUsd + r.tokenUsage.estimatedCostUsd,
          }),
          { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 },
        );
        report = {
          summary: 'Synthesizer unavailable — raw agent findings shown.',
          findings: allFindings,
          agentResults,
          totalUsage,
          hasCritical: allFindings.some((f) => f.severity === 'critical'),
          markdownBody: '',
          generatedAt: new Date().toISOString(),
        };
        report.markdownBody = buildMarkdownFromScratch(report);
      }

      // ── 5. Render output ──────────────────────────────────────────────────
      const content = config.jsonOutput ? renderJson(report) : renderMarkdown(report);

      if (config.output) {
        await writeReport(content, config.output);
        console.log(chalk.green(`\n📄 Report written to: ${chalk.bold(config.output)}`));
        if (!config.jsonOutput) {
          // Also print a compact findings summary to stdout
          printFindingsSummary(report.findings);
        }
      } else {
        console.log('\n' + content);
      }

      // ── 6. --fix mode ────────────────────────────────────────────────────
      if (flags['fix']) {
        const fixSeverity = (flags['fixSeverity'] as Severity | undefined) ?? 'low';
        const dryRun = false;
        spinner.start(`Applying fixes for ${fixSeverity} and info findings…`);
        const fixResults = await applyFixes(report.findings, config, {
          repoRoot: gitRoot,
          maxSeverity: fixSeverity,
          dryRun,
        });
        spinner.stop();

        if (fixResults.length === 0) {
          console.log(chalk.dim('  No eligible findings to auto-fix.'));
        } else {
          for (const r of fixResults) {
            const icon =
              r.status === 'applied' ? chalk.green('✓') :
              r.status === 'skipped' ? chalk.yellow('–') :
              chalk.red('✗');
            const sev = SEV_COLOR[r.finding.severity](`[${r.finding.severity}]`);
            console.log(`  ${icon} ${sev} ${chalk.bold(r.finding.file)} — ${r.finding.category}`);
            if (r.reason) console.log(`    ${chalk.dim(r.reason)}`);
          }
          const applied = fixResults.filter((r) => r.status === 'applied').length;
          console.log(chalk.green(`\n  ✓ ${applied}/${fixResults.length} fix${applied !== 1 ? 'es' : ''} applied`));
        }
      }

      // ── 7. Cost summary ───────────────────────────────────────────────────
      const u = report.totalUsage;
      console.log(
        chalk.dim(
          `\n💰 Total cost: $${u.estimatedCostUsd.toFixed(4)} ` +
          `(${(u.inputTokens + u.outputTokens).toLocaleString('en-US')} tokens` +
          (u.cacheReadTokens > 0 ? `, ${u.cacheReadTokens.toLocaleString('en-US')} cache-read` : '') +
          `)`,
        ),
      );

      // ── 7. Exit code ──────────────────────────────────────────────────────
      if (config.failOn !== 'never') {
        const threshold = SEVERITY_ORDER[config.failOn as Severity];
        const blocking = report.findings.filter(
          (f) => SEVERITY_ORDER[f.severity] <= threshold,
        );
        if (blocking.length > 0) {
          console.error(
            chalk.red(
              `\n⛔ Exiting with code 1: ${blocking.length} finding${blocking.length !== 1 ? 's' : ''} ` +
              `at or above ${chalk.bold(config.failOn)} severity.`,
            ),
          );
          process.exit(1);
        }
      }

    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

// ── Init subcommand ───────────────────────────────────────────────────────────

program
  .command('init')
  .description('Create a .agentreviewrc config file in the current directory')
  .action(() => {
    const dest = '.agentreviewrc';
    if (existsSync(dest)) {
      console.log(chalk.yellow(`${dest} already exists — not overwriting.`));
      process.exit(0);
    }
    writeFile(dest, RC_TEMPLATE, 'utf-8', (err) => {
      if (err) {
        console.error(chalk.red(`Failed to write ${dest}: ${err.message}`));
        process.exit(1);
      }
      console.log(chalk.green(`✓ Created ${dest}`));
      console.log(chalk.dim('Edit it to customize base branch, agents, model, and ignore patterns.'));
    });
  });

// ── Parse ──────────────────────────────────────────────────────────────────────

program.parse();

// ── Helpers ───────────────────────────────────────────────────────────────────

function printFindingsSummary(findings: import('./types.js').Finding[]): void {
  if (findings.length === 0) {
    console.log(chalk.green('\n✅ No findings.'));
    return;
  }
  console.log(chalk.bold('\nFindings:'));
  for (const f of findings) {
    const loc = f.line !== null ? `:${f.line}` : '';
    const sev = SEV_COLOR[f.severity](`[${f.severity}]`);
    console.log(`  ${sev} ${chalk.dim(f.file + loc)} ${f.category}`);
    console.log(`    ${chalk.gray(f.description.slice(0, 80))}${f.description.length > 80 ? '…' : ''}`);
  }
}
