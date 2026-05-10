/**
 * Converts agentreview Finding objects into VS Code Diagnostics and manages
 * a DiagnosticCollection so the Problems panel and editor squiggles stay fresh.
 */
import * as vscode from 'vscode';

// ── Finding shape (mirrors src/types.ts without pulling in the whole package) ──

export interface Finding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  file: string;
  line: number | null;
  category: string;
  description: string;
  suggestion: string;
}

// ── Severity mapping ──────────────────────────────────────────────────────────

const SEV_TO_DIAGNOSTIC: Record<Finding['severity'], vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  high: vscode.DiagnosticSeverity.Error,
  medium: vscode.DiagnosticSeverity.Warning,
  low: vscode.DiagnosticSeverity.Information,
  info: vscode.DiagnosticSeverity.Hint,
};

// ── Manager ───────────────────────────────────────────────────────────────────

export class DiagnosticsManager {
  private readonly collection: vscode.DiagnosticCollection;

  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('agentreview');
  }

  /**
   * Replaces all current diagnostics with the findings from the latest review.
   * @param findings  Parsed Finding[] from agentreview --json output.
   * @param repoRoot  Absolute path to the repository root (to resolve relative file paths).
   */
  update(findings: Finding[], repoRoot: string): void {
    this.collection.clear();

    // Group findings by file
    const byFile = new Map<string, Finding[]>();
    for (const f of findings) {
      const existing = byFile.get(f.file) ?? [];
      existing.push(f);
      byFile.set(f.file, existing);
    }

    const entries: [vscode.Uri, vscode.Diagnostic[]][] = [];

    for (const [relPath, filFindings] of byFile) {
      const uri = vscode.Uri.file(`${repoRoot}/${relPath}`.replace(/\\/g, '/'));
      const diagnostics = filFindings.map((f) => buildDiagnostic(f));
      entries.push([uri, diagnostics]);
    }

    this.collection.set(entries);
  }

  /** Remove all agentreview diagnostics from every file. */
  clear(): void {
    this.collection.clear();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

// ── Builder ───────────────────────────────────────────────────────────────────

function buildDiagnostic(f: Finding): vscode.Diagnostic {
  // Lines in VS Code are 0-indexed; agentreview uses 1-indexed lines.
  // A null line maps to line 0 (top of file).
  const lineIndex = f.line !== null ? Math.max(0, f.line - 1) : 0;
  const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_SAFE_INTEGER);

  const message = `[${f.severity.toUpperCase()}] ${f.category}: ${f.description}\n\nSuggestion: ${f.suggestion}`;
  const severity = SEV_TO_DIAGNOSTIC[f.severity];

  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'agentreview';
  diagnostic.code = f.category;

  return diagnostic;
}
