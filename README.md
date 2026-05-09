# agentreview

[![npm version](https://img.shields.io/npm/v/agentreview.svg)](https://www.npmjs.com/package/agentreview)
[![CI](https://github.com/YOUR_GITHUB_USERNAME/agentreview/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USERNAME/agentreview/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)

**Multi-agent AI code review for your git diff — powered by Anthropic Claude.**

Five specialized agents review your diff in parallel (security, performance, style, tests, docs), then a synthesizer deduplicates and prioritizes their findings into a single Markdown report. Designed for local use and CI pipelines.

---

## 30-second quickstart

```bash
# 1. Install
npm install -g agentreview

# 2. Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Run inside any git repo
cd your-project
agentreview
```

That's it. `agentreview` diffs your current branch against `origin/main`, runs five agents in parallel, and prints the report to stdout.

---

## Demo

> _Terminal recording coming soon — run `agentreview --help` to see all options._

---

## Architecture

```mermaid
flowchart LR
    GD[git diff] --> O[Orchestrator\nPromise.allSettled]

    O --> SA[SecurityAgent]
    O --> PA[PerformanceAgent]
    O --> STA[StyleAgent]
    O --> TA[TestsAgent]
    O --> DA[DocsAgent]

    SA --> |Finding[]| SY
    PA --> |Finding[]| SY
    STA --> |Finding[]| SY
    TA --> |Finding[]| SY
    DA --> |Finding[]| SY

    SY[Synthesizer\nClaude] --> R[Reporter]
    R --> STDOUT[stdout / file]
    R --> EC[exit code]
```

Each agent receives **only the diff** — they cannot see each other's findings. The Synthesizer is the only component that sees all findings at once, giving it a clean signal to deduplicate and resolve conflicts.

---

## Why multi-agent instead of one big prompt?

| Approach | Single prompt | Multi-agent (this tool) |
|----------|--------------|------------------------|
| **Specialization** | Generalist — misses domain-specific patterns | Each agent has a focused persona and category list |
| **Parallelism** | Sequential | All agents run simultaneously via `Promise.all` |
| **Extensibility** | Edit one monolithic prompt | Add a new file in `src/agents/` + a prompt in `prompts/` |
| **Failure isolation** | One bad response ruins everything | One agent failure is logged; the rest continue |
| **Cost transparency** | Opaque | Per-agent token usage tracked and reported |

---

## CLI reference

```
Usage: agentreview [options] [path]

Arguments:
  path                    Path to git repo (default: current directory)

Options:
  -b, --base <ref>        Base git ref to diff against (default: origin/main)
  -a, --agents <names>    Comma-separated agents: security,performance,style,tests,docs
  -o, --output <file>     Also write report to a file
  --json                  Output machine-readable JSON instead of Markdown
  --fail-on <severity>    Exit 1 if findings >= severity (critical|high|medium|low|never)
  -V, --version           Print version
  -h, --help              Show help

Commands:
  init                    Create a .agentreviewrc config file
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
```

---

## Configuration

Run `agentreview init` to create a `.agentreviewrc` in your project root:

```json
{
  "base": "origin/main",
  "agents": ["security", "performance", "style", "tests"],
  "model": "claude-sonnet-4-6",
  "maxTokensPerAgent": 4000,
  "ignorePatterns": ["**/*.lock", "**/dist/**"]
}
```

Config is discovered by walking up directories from your current working directory, so you can keep it at the repo root. CLI flags always override the config file.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | **Required.** Your Anthropic API key. |
| `AGENTREVIEW_MODEL` | Override the model (e.g. `claude-opus-4-7`). |

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

```markdown
# My Agent

You are an expert in [domain]...

## Response Format
Return ONLY a JSON code block:
```json
[{ "severity": "...", "file": "...", "line": ..., "category": "...",
   "description": "...", "suggestion": "..." }]
```
```

**3. Register it** in `src/agents/index.ts`:

```ts
import { MyAgent } from './my-agent.js';

const AGENT_REGISTRY = {
  // ...existing agents...
  'my-agent': () => new MyAgent(),
};
```

Then run: `agentreview --agents security,my-agent`

The `BaseAgent` base class handles all the boilerplate: loading the prompt from disk, calling the Anthropic API with prompt caching enabled, parsing and validating the JSON response with Zod, and wrapping errors so one bad agent never crashes the whole run.

---

## Limitations

- **Large diffs** are truncated at ~150,000 characters with a warning. For very large PRs, consider running with `--agents security` to focus on the highest-value review.
- **Anthropic API only** in v1. The `Agent` interface makes it straightforward to swap the underlying model — see the roadmap.
- **Read-only** — `agentreview` never modifies files. Auto-fix is a different product.
- **No history** — findings are not persisted between runs. Each run is stateless.

---

## Roadmap

- [ ] **VS Code extension** — inline finding annotations using the same agent architecture
- [ ] **GitHub Action** — post review findings as PR comments
- [ ] **`--fix` mode** — apply suggestions from low-risk findings automatically (opt-in)
- [ ] **Additional agents** — dependency audit, accessibility, i18n
- [ ] **Provider-agnostic mode** — the `Agent` interface already abstracts the API; swap in OpenAI, Gemini, or a local model

---

## Development

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/agentreview
cd agentreview
npm install
npm test          # 38 tests, no API calls needed
npm run build     # produces dist/cli.js
npm run dev -- --help   # run CLI locally with tsx
```

---

## Inspiration

Based on an internal tool I built at work as a VS Code extension. This is an open-source rewrite of the architecture I found most useful — separating concerns across focused agents rather than one large prompt.

---

## License

MIT
