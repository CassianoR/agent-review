/**
 * agentreview VS Code Extension
 *
 * Registers two commands:
 *   agentreview.reviewDiff        — run a full review and show inline diagnostics
 *   agentreview.clearDiagnostics  — clear all agentreview diagnostics
 *
 * The extension shells out to the `agentreview` CLI with `--json` and parses
 * the JSON report to populate a DiagnosticCollection (Problems panel + squiggles).
 */
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DiagnosticsManager } from './diagnostics.js';
import type { Finding } from './diagnostics.js';

const execFileAsync = promisify(execFile);

// ── ReviewReport shape (minimal — we only need findings) ─────────────────────

interface ReviewReport {
  findings: Finding[];
  summary?: string;
  hasCritical?: boolean;
}

// ── Extension lifecycle ───────────────────────────────────────────────────────

let diagnosticsManager: DiagnosticsManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  diagnosticsManager = new DiagnosticsManager();
  context.subscriptions.push({ dispose: () => diagnosticsManager?.dispose() });

  context.subscriptions.push(
    vscode.commands.registerCommand('agentreview.reviewDiff', () => runReview(context)),
    vscode.commands.registerCommand('agentreview.clearDiagnostics', () => {
      diagnosticsManager?.clear();
      vscode.window.showInformationMessage('agentreview: All findings cleared.');
    }),
  );

  // Optional: auto-review on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      const cfg = vscode.workspace.getConfiguration('agentreview');
      if (cfg.get<boolean>('autoReviewOnSave') === true) {
        void runReview(context);
      }
    }),
  );
}

export function deactivate(): void {
  diagnosticsManager?.dispose();
}

// ── Review runner ─────────────────────────────────────────────────────────────

async function runReview(context: vscode.ExtensionContext): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('agentreview: No workspace folder is open.');
    return;
  }
  const repoRoot = workspaceFolder.uri.fsPath;

  const cfg = vscode.workspace.getConfiguration('agentreview');
  const cliPath = cfg.get<string>('cliPath') ?? 'agentreview';
  const provider = cfg.get<string>('provider') ?? 'anthropic';
  const model = cfg.get<string>('model') ?? '';
  const baseRef = cfg.get<string>('baseRef') ?? '';
  const agents = (cfg.get<string[]>('agents') ?? []).join(',');
  const anthropicKey = cfg.get<string>('anthropicApiKey') ?? '';
  const openaiKey = cfg.get<string>('openaiApiKey') ?? '';

  const args: string[] = ['--json', '--provider', provider];
  if (model) args.push('--model', model); // not a CLI flag yet — reserved
  if (baseRef) args.push('--base', baseRef);
  if (agents) args.push('--agents', agents);

  // Inject API keys from extension settings into the subprocess environment
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (anthropicKey) env['ANTHROPIC_API_KEY'] = anthropicKey;
  if (openaiKey) env['OPENAI_API_KEY'] = openaiKey;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'agentreview',
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: 'Running agents…' });

      let stdout: string;
      try {
        const result = await execFileAsync(cliPath, args, {
          cwd: repoRoot,
          env,
          maxBuffer: 10 * 1024 * 1024, // 10 MB — large diffs + JSON
        });
        stdout = result.stdout;
      } catch (err: unknown) {
        // execFileAsync throws when the CLI exits non-zero (e.g. --fail-on triggered).
        // The JSON report is still on stdout — try to use it before bailing.
        const execError = err as { stdout?: string; stderr?: string; code?: number };
        stdout = execError.stdout ?? '';
        if (!stdout.trim()) {
          const detail = execError.stderr?.trim() || String(err);
          vscode.window.showErrorMessage(`agentreview failed: ${detail}`);
          return;
        }
      }

      let report: ReviewReport;
      try {
        report = parseReport(stdout);
      } catch {
        vscode.window.showErrorMessage('agentreview: Could not parse JSON report. Check the Output panel for details.');
        void outputChannel(context).then((ch) => { ch.appendLine(stdout); ch.show(); });
        return;
      }

      progress.report({ message: 'Updating diagnostics…' });
      diagnosticsManager?.update(report.findings, repoRoot);

      const count = report.findings.length;
      if (count === 0) {
        vscode.window.showInformationMessage('agentreview: No findings. ✅');
      } else {
        const hasCritical = report.hasCritical ?? report.findings.some((f) => f.severity === 'critical');
        const icon = hasCritical ? '🔴' : '🟡';
        vscode.window
          .showWarningMessage(
            `${icon} agentreview: ${count} finding${count !== 1 ? 's' : ''} — see Problems panel.`,
            'Open Problems',
          )
          .then((choice) => {
            if (choice === 'Open Problems') {
              void vscode.commands.executeCommand('workbench.actions.view.problems');
            }
          });
      }
    },
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses the JSON emitted by `agentreview --json`.
 * The CLI may prepend spinner/chalk output before the JSON block — scan for the
 * first `{` to skip ANSI-decorated lines.
 */
function parseReport(raw: string): ReviewReport {
  // Strip ANSI escape codes before parsing
  const clean = raw.replace(/\x1B\[[0-9;]*m/g, '');
  // Find the first JSON object in the output
  const start = clean.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in output');
  return JSON.parse(clean.slice(start)) as ReviewReport;
}

let _outputChannel: vscode.OutputChannel | undefined;
async function outputChannel(_ctx: vscode.ExtensionContext): Promise<vscode.OutputChannel> {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('agentreview');
  }
  return _outputChannel;
}
