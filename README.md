# agentreview

[![npm version](https://img.shields.io/npm/v/agentreview.svg)](https://www.npmjs.com/package/agentreview)
[![CI](https://github.com/CassianoR/agent-review/actions/workflows/ci.yml/badge.svg)](https://github.com/CassianoR/agent-review/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Multi-agent AI code review for your git diff — powered by Anthropic Claude (or OpenAI).**

Eight specialized agents review your diff in parallel, then a synthesizer deduplicates and prioritizes their findings into a single Markdown report. Runs as a CLI, a GitHub Action, or a VS Code extension.

---

## 30-second quickstart

```bash
# 1. Install
npm install -g agentreview

# 2. Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run inside any git repo
cd your-project
agentreview
```

`agentreview` diffs your current branch against `origin/main`, runs all agents in parallel, and prints a prioritized Markdown report to stdout.

---

## Demo

> _Terminal recording coming soon — run `agentreview --help` to see all options._

---

## Architecture

```mermaid
flowchart LR
    GD[git diff] --> O[Orchestrator\nPromise.allSettled]

    O --> A1[SecurityAgent]
    O --> A2[PerformanceAgent]
    O --> A3[StyleAgent]
    O --> A4[TestsAgent]
    O --> A5[DocsAgent]
    O --> A6[DependencyAgent]
    O --> A7[AccessibilityAgent]
    O --> A8[I18nAgent]

    A1 & A2 & A3 & A4 & A5 & A6 & A7 & A8 --> |Finding[]| SY

    SY[Synthesizer\nLLM] --> R[Reporter]
    R --> STDOUT[stdout / file]
    R --> PR[GitHub PR comments]
    R --> VS[VS Code diagnostics]
```

Each agent receives **only the diff** — they cannot see each other's findings. The Synthesizer is the only component that sees all findings at once, giving it a clean signal to deduplicate and resolve conflicts.

---

## Why multi-agent instead of one big prompt?

| Approach | Single prompt | Multi-agent (this tool) |
|----------|--------------|------------------------|
| **Specialization** | Generalist — misses domain-specific patterns | Each agent has a focused persona and category list |
| **Parallelism** | Sequential | All agents run simultaneously via `Promise.allSettled` |
| **Extensibility** | Edit one monolithic prompt | Add a new file in `src/agents/` + a prompt in `prompts/` |
| **Failure isolation** | One bad response ruins everything | One agent failure is logged; the rest continue |
| **Cost transparency** | Opaque | Per-agent token usage tracked and reported |

---

## Agents

| Agent | What it looks for |
|-------|------------------|
| `security` | Injection, secrets, broken auth, crypto misuse (OWASP Top 10 / CWE) |
| `performance` | N+1 queries, blocking I/O, sequential awaits, memory leaks, bundle size |
| `style` | Naming, complexity, duplication, dead code, type safety, error handling |
| `tests` | Missing coverage, weak assertions, edge cases, test isolation |
| `docs` | Missing JSDoc, outdated comments, missing README sections |
| `dependency` | Known CVEs, unpinned versions, abandoned packages, license risk |
| `accessibility` | WCAG 2.2 AA — missing alt/labels, keyboard traps, ARIA misuse |
| `i18n` | Hardcoded strings, locale/timezone assumptions, missing pluralization |

---

## CLI reference

```
Usage: agentreview [options] [path]

Arguments:
  path                       Path to git repo (default: current directory)

Options:
  -b, --base <ref>           Base git ref to diff against (default: origin/main)
  -a, --agents <names>       Comma-separated list of agents to run
  -o, --output <file>        Also write report to a file
  --json                     Output machine-readable JSON instead of Markdown
  --fail-on <severity>       Exit 1 if findings >= severity (critical|high|medium|low|never)
  --provider <name>          LLM backend: anthropic (default) or openai
  --fix                      Auto-apply suggestions for low/info findings (opt-in)
  --fix-severity <severity>  Maximum severity to auto-fix when --fix is used (default: low)
  --fix-dry-run              Preview what --fix would change without writing to disk
  --fix-verbose              Show full unified diff for every file changed by --fix
  -V, --version              Print version
  -h, --help                 Show help

Commands:
  init                       Create a .agentreviewrc config file
```

### Examples

```bash
# Review only security and performance agents
agentreview --agents security,performance

# Review against a feature branch base, write to file
agentreview --base origin/develop --output review.md

# CI mode: fail on high-severity and above
agentreview --fail-on high

# Machine-readable output for downstream tooling
agentreview --json | jq '.findings[] | select(.severity == "critical")'

# Use OpenAI instead of Anthropic
agentreview --provider openai  # requires OPENAI_API_KEY

# Auto-fix low-risk findings (rewrites files in place)
agentreview --fix

# Auto-fix up to medium severity (use with caution)
agentreview --fix --fix-severity medium
```

---

## Configuration

Run `agentreview init` to create a `.agentreviewrc` in your project root:

```json
{
  "base": "origin/main",
  "agents": ["security", "performance", "style", "tests", "docs", "dependency", "accessibility", "i18n"],
  "model": "claude-sonnet-4-6",
  "maxTokensPerAgent": 4000,
  "ignorePatterns": ["**/*.lock", "**/dist/**"]
}
```

Config is discovered by walking up directories from your current working directory. CLI flags always override the config file.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Required when using the Anthropic provider (default). |
| `OPENAI_API_KEY` | Required when using `--provider openai`. |
| `AGENTREVIEW_MODEL` | Override the model (e.g. `claude-opus-4-7`, `gpt-4o`). |
| `AGENTREVIEW_PROVIDER` | Override the provider (`anthropic` or `openai`). |

---

## `--fix` mode

The `--fix` flag lets `agentreview` apply suggestions automatically for low-risk findings.

### How it works

1. Eligible findings (severity ≤ `--fix-severity`, default `low`) are **grouped by file**.
2. For each file, a single LLM call addresses **all findings in that file at once** — cheaper and faster than one call per finding.
3. Files are processed **in parallel** — the total time is roughly that of the slowest file, not the sum.
4. The model returns the entire file with all fixes applied inside a ` ```fix ``` ` block.
5. A **sanity check** rejects patches where the file shrank by more than 50 % (catches model truncation).
6. The patched file is written to disk only if the content changed and all checks pass.

**Critical and high findings are always excluded** regardless of the threshold — automated changes to security-sensitive code require human review.

### Flags

```bash
agentreview --fix                        # fix low + info (default), write to disk
agentreview --fix --fix-severity medium  # also fix medium severity
agentreview --fix-dry-run                # preview what would change — nothing written
agentreview --fix --fix-verbose          # apply and show the full unified diff
```

### Output example

```
  ✓ src/auth.ts — 2 findings (+3 −5 lines)
    · [low] naming:10
    · [info] dead-code:44
    @@ -8,7 +8,7 @@ ...

  – src/utils.ts — 1 finding
    · [low] style:22
    Model returned unchanged content

  ✓ 1/2 files patched (+3 −5 lines)  1 skipped
  Run with --fix-verbose to see the full diff.
```

### When the model skips a fix

If the model cannot safely apply all fixes in a file without side effects, it responds with `SKIP: <reason>` and the file is left untouched. The skip reason is shown in the output. In this case, review the finding manually or try running with a narrower `--agents` selection.

---

## GitHub Action

Add `agentreview` to your CI pipeline to get inline PR comments on every pull request:

```yaml
# .github/workflows/review.yml
name: agentreview

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: CassianoR/agent-review@master
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on: critical          # exit 1 only for critical findings
          agents: security,performance,style,tests,docs,dependency,accessibility,i18n
```

### Action inputs

| Input | Default | Description |
|-------|---------|-------------|
| `anthropic-api-key` | — | **Required** when using Anthropic. Store as a secret. |
| `openai-api-key` | `''` | Required when `provider` is `openai`. |
| `provider` | `anthropic` | LLM backend: `anthropic` or `openai`. |
| `agents` | all 8 | Comma-separated list of agents to run. |
| `base-ref` | PR base branch | Git ref to diff against. |
| `model` | `claude-sonnet-4-6` | Model name. |
| `fail-on` | `critical` | Exit code 1 when findings reach this severity. |
| `post-comments` | `true` | Post findings as inline PR review comments. |
| `github-token` | `${{ github.token }}` | Token for posting PR comments. |

### Action outputs

| Output | Description |
|--------|-------------|
| `findings-count` | Total number of unique findings. |
| `has-critical` | `"true"` if any critical finding was found. |
| `report-json` | Path to the JSON report artifact on the runner. |

---

## VS Code extension

The `packages/vscode/` directory contains a VS Code extension that runs `agentreview` and shows findings as inline squiggles and Problems panel entries — no terminal needed.

### Usage

1. Install the `agentreview` CLI globally: `npm install -g agentreview`
2. Open a git repository in VS Code.
3. Run **agentreview: Review diff against base branch** from the Command Palette (`Ctrl/Cmd+Shift+P`).
4. Findings appear immediately as squiggles in the editor and entries in the Problems panel.

### Extension settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentreview.anthropicApiKey` | `''` | API key (or set `ANTHROPIC_API_KEY` in your shell). |
| `agentreview.openaiApiKey` | `''` | OpenAI key when provider is `openai`. |
| `agentreview.provider` | `anthropic` | LLM provider. |
| `agentreview.model` | `claude-sonnet-4-6` | Model name. |
| `agentreview.agents` | all 8 | Agents to run. |
| `agentreview.baseRef` | `''` | Git ref to diff against (defaults to tracked upstream). |
| `agentreview.cliPath` | `agentreview` | Path to the CLI binary. |
| `agentreview.autoReviewOnSave` | `false` | Run a review automatically on every file save. |

---

## Provider support

`agentreview` ships with two built-in providers. The `LLMProvider` interface makes it straightforward to add others.

| Provider | Flag | Required env var | Default model |
|----------|------|-----------------|---------------|
| Anthropic Claude | `--provider anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` |
| OpenAI | `--provider openai` | `OPENAI_API_KEY` | `gpt-4o` |

The `openai` package is an **optional peer dependency** — install it only when you actually need the OpenAI backend:

```bash
npm install -g agentreview
npm install -g openai          # only needed for --provider openai
agentreview --provider openai
```

---

## How to write a custom agent

Agents are plain TypeScript classes — add one in three steps:

**1. Create the class** (`src/agents/my-agent.ts`):

```ts
import { BaseAgent } from './base.js';

export class MyAgent extends BaseAgent {
  readonly name = 'my-agent' as const;
  protected readonly promptFile = 'my-agent'; // loads prompts/my-agent.md
}
```

**2. Write the prompt** (`prompts/my-agent.md`):

````markdown
# My Agent

You are an expert in [domain]. Review the diff below for [concerns].

## Response Format

Return ONLY a JSON code block — no prose, no explanation:

```json
[{
  "severity": "high",
  "file": "src/example.ts",
  "line": 42,
  "category": "my-category",
  "description": "What is wrong and why it matters.",
  "suggestion": "Concrete fix or improvement."
}]
```

Return `[]` if no issues are found.
````

**3. Register it** in `src/agents/index.ts`:

```ts
import { MyAgent } from './my-agent.js';

const AGENT_REGISTRY = {
  // ...existing agents...
  'my-agent': () => new MyAgent(),
};
```

Then run: `agentreview --agents security,my-agent`

`BaseAgent` handles all boilerplate: loading the prompt from disk, calling the LLM via the injected provider, prompt caching (`cache_control: ephemeral`), Zod validation of the JSON response with partial recovery, and isolating errors so one bad agent never crashes the run.

---

## Limitations

- **Large diffs** are truncated at ~150,000 characters with a warning. For very large PRs, use `--agents security` to focus on the highest-value review.
- **No history** — findings are not persisted between runs. Each run is stateless.
- **`--fix` is conservative by design** — only `low` and `info` findings are eligible by default. Always review the diff before committing auto-fixed files.

---

## Development

```bash
git clone https://github.com/CassianoR/agent-review
cd agent-review
npm install
npm test            # 82 tests, no API calls needed (all mocked)
npm run build       # produces dist/cli.js and dist/github-action.js
npm run typecheck   # strict TypeScript, zero errors
npm run dev -- --help   # run CLI locally with tsx
```

### Project structure

```
src/
  agents/         # One file per agent (security, performance, …)
  providers/      # LLMProvider interface + Anthropic / OpenAI implementations
  git/            # simple-git wrapper for computing diffs
  cli.ts          # Commander CLI entry point
  orchestrator.ts # Promise.allSettled parallel runner
  synthesizer.ts  # Deduplication + Markdown generation via LLM
  reporter.ts     # Markdown / JSON rendering helpers
  fixer.ts        # --fix mode: per-finding LLM patch application
  config.ts       # RC file discovery + flag merging
  types.ts        # Zod schemas + shared interfaces
  github-action.ts # GitHub Action entry point

prompts/          # Markdown prompt files, one per agent
packages/
  vscode/         # VS Code extension (standalone esbuild package)
tests/            # Vitest test suite (all mocked — no real API calls)
```

---

## Inspiration

Born from an internal tool at work, rewritten as an open-source project to explore the multi-agent pattern: rather than cramming everything into one large prompt, splitting concerns across focused, parallel agents produces more reliable and maintainable reviews.

---

## License

MIT
