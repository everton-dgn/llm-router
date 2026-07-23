# llm-router

[![CI](https://github.com/everton-dgn/llm-router/actions/workflows/ci.yml/badge.svg)](https://github.com/everton-dgn/llm-router/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Local message router for OpenCode. It keeps one visible conversation while
selecting MiniMax M3, GLM 5.2, Claude Opus 4.8, or GPT-5.6 Sol as the worker for
each message.

The composer always stays on the primary `router` agent. The plugin changes the
effective worker for the current message and displays that destination in the
OpenCode interface.

> Project status: pre-1.0 and under active development. The current integration
> is pinned to OpenCode 1.18.4. Review the
> [compatibility contract](docs/compatibility.md) before upgrading OpenCode or
> the provider SDKs.

## Why

A full orchestration turn adds latency, cost, and another model that can distort
the request. llm-router uses a small local Ollama model for one deterministic
classification, then hands the original message to the selected native worker.
The classifier exits immediately after returning the route.

Routing and tool control are independent:

- routing mode: `auto`, `adaptive`, or `pinned`;
- execution profile: `native`, `restricted`, or `full`.

All nine combinations are valid. A model selected by the router keeps its native
OpenCode capabilities unless the user explicitly selects a restrictive profile.

## Routing modes

| Mode | Behavior | Typical use |
| --- | --- | --- |
| `auto` | Classifies every message independently | Short, mixed requests |
| `adaptive` | Promotes immediately and requires evidence before downgrading | General use with fewer unnecessary switches |
| `pinned` | Selects the first worker and keeps it for the session | Long work that must stay on one model |

Resuming a session preserves its routing state. A fork gets a new session ID,
copies the visible conversation, and makes an independent routing decision.

## Execution profiles

| Profile | Behavior |
| --- | --- |
| `native` | Adds no llm-router tool restrictions |
| `restricted` | Applies configured `allow`, `ask`, `deny`, and turn limits |
| `full` | Explicitly allows every tool exposed by the host |

The shipped default is `native` for every worker. Project policy files may reduce
permissions, but they cannot silently expand a user's global policy.

See [routing modes](docs/routing-modes.md) and
[execution policies](docs/execution-policies.md) for the complete state and
configuration contracts.

## Default route matrix

| Intent | Route | OpenCode destination |
| --- | --- | --- |
| Literal lookup and mechanical formatting | MiniMax | `minimax-coding-plan/MiniMax-M3` |
| Translation and simple or intermediate work | GLM | `zai-coding-plan/glm-5.2` |
| Product, architecture, strategy, and complex creative work | Claude | `claude-agent/claude-opus-4-8` |
| Review, security, difficult engineering, and precise technical writing | Codex | `openai/gpt-5.6-sol` |

These routes express a cost and capability preference. They do not grant or
remove tools.

## How one message flows

```text
user message in the router
  -> OpenCode chat.message hook
  -> read session routing mode and execution profile
  -> local route --classify --json
  -> Ollama Plano-Orchestrator-4B
  -> auto, adaptive, or pinned selects the destination
  -> replace agent/model on the same message
  -> MiniMax, GLM, Claude Agent SDK, or Codex executes
  -> response appears in the current session
```

There is no coordinator turn after the worker responds. In `pinned` mode, the
stored worker is reused without calling the classifier again.

Before an OpenCode compaction, the same local model performs a separate,
bounded summarization job over an already sanitized transcript. The resulting
checkpoint is versioned and bound to one compaction ID. A failed or invalid
summary falls back to the active conversation tail and produces a visible
warning.

## Requirements

- macOS or Linux;
- OpenCode 1.18.4;
- Node.js 22.22.2, 24.15.0, or a newer supported release, plus `pnpm`;
- Python 3.11 or newer through `uv`, for benchmarks and Python tests;
- Ollama with the configured local classifier;
- Claude Code installed and authenticated;
- `curl`, `jq`, `trash`, and a POSIX shell;
- OpenAI authenticated in OpenCode;
- `MINIMAX_API_KEY` and `ZAI_API_KEY` in the environment that starts OpenCode.

Windows has not been validated. See [compatibility](docs/compatibility.md) for
the tested and untested surfaces.

## Quick start

Clone the repository:

```bash
git clone https://github.com/everton-dgn/llm-router.git
cd llm-router
```

Install the repository tooling. This also installs the versioned Git hooks:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Install the local classifier:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
```

Authenticate Claude Code:

```bash
claude auth login
claude auth status
```

Preview the OpenCode bundle installation:

```bash
opencode_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
bash opencode/install.sh --config-dir "$opencode_config_dir" --dry-run
```

Install it:

```bash
bash opencode/install.sh --config-dir "$opencode_config_dir"
pnpm --dir "$opencode_config_dir" install --no-optional
```

The installer does not run a package manager. It merges the router-owned
providers, agents, commands, and defaults into an existing `opencode.jsonc`
while preserving comments and unrelated settings. Every changed managed file
is backed up under `/tmp/claude-backups/<timestamp>/`; the user's policy file
is preserved, and repeated identical installations are a no-op.

Start OpenCode in the project where you want to work:

```bash
opencode .
```

The default session uses `adaptive + native`.

## Session commands

```text
/router-status
/router-auto
/router-adaptive
/router-pinned
/router-native
/router-restricted
/router-full
```

Routing commands preserve the current execution profile. Profile commands
preserve the current routing mode. The control provider handles these commands
locally without calling an LLM.

## Claude Agent SDK integration

The local `claude-agent` provider implements the `LanguageModelV3` contract
expected by OpenCode and calls `query()` from the official
`@anthropic-ai/claude-agent-sdk`.

It points at the Claude Code executable already installed on the machine. The
adapter does not load credentials from files or persist them. It filters the
parent environment and passes allowed Claude or Anthropic authentication
variables to the Claude Code subprocess. OpenCode remains the source of
conversation history, while the adapter projects only approved user and
assistant text, supported attachments, completed task results, and the
validated compaction checkpoint.

Supported attachments are plain text, PDF, GIF, JPEG, PNG, and WebP. Agent
mentions run as OpenCode child sessions and their completed results are inserted
before Claude receives the message.

Read [Claude via Agent SDK](docs/claude.md) for the context, attachment,
permission, and transport limits.

## Privacy and cost

The classifier and compaction summarizer run through the configured local Ollama
service. The selected worker still receives the approved message context through
its own provider, so its normal provider privacy and billing terms apply.

Do not publish `opencode debug config`; it may expand environment values. Use
the agent-specific debug commands documented in
[privacy and costs](docs/privacy-and-costs.md).

## Documentation

| Document | Purpose |
| --- | --- |
| [Documentation index](docs/README.md) | Complete map |
| [Quick start](docs/quick-start.md) | Installation and first session |
| [Routing modes](docs/routing-modes.md) | Mode state, context, resume, and fork |
| [Execution policies](docs/execution-policies.md) | Permissions, profiles, and configuration |
| [Claude Agent SDK](docs/claude.md) | Context, attachments, tools, and authentication |
| [Compatibility](docs/compatibility.md) | Version and operating-system contract |
| [Privacy and costs](docs/privacy-and-costs.md) | Data boundaries and provider billing |
| [Uninstall and rollback](docs/uninstall.md) | Restore or remove the installed bundle |
| [Development](docs/development.md) | Local validation and contribution workflow |
| [Troubleshooting](docs/troubleshooting.md) | Diagnostics and safe recovery |
| [Release](docs/RELEASE.md) | Changelog, SemVer, tags, and GitHub Releases |
| [Public repository checklist](docs/publication-checklist.md) | Visibility and security publication gates |
| [Benchmark](BENCHMARK.md) | Offline methodology, results, and limitations |

## Development

The runtime bundle has its own pinned dependencies under `opencode/`. Root
scripts cover repository validation and release tooling.

Install repository tooling. This also installs the local Lefthook hooks:

```bash
pnpm install --frozen-lockfile
```

Run local validation:

```bash
pnpm test
```

Run the live Ollama routing contract separately:

```bash
pnpm test:integration
```

The underlying suites can also be run directly:

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
bash tests/opencode-bundle.sh
node --test tests/*.test.mjs
uv run --no-project --no-python-downloads python -m unittest \
  tests/test_stage_verifier.py tests/test_quality_eval.py
```

The routing evaluation calls the local Ollama classifier. `pnpm test` matches CI
and does not require provider credentials or a running Ollama service.
Lefthook runs Commitlint for commit messages, selects focused tests from staged
files before a commit, and runs the deterministic gate before a push.

## Offline benchmark

`quality_eval.py` and `qeval/` reproduce the offline single-shot benchmark
runner. They are not installed into OpenCode and do not participate in message
routing.

Validate the benchmark configuration without provider calls:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases-v2.json \
  --output /tmp/llm-router-quality.json \
  --validate-only
```

The published benchmark includes methodology and artifact hashes. Raw provider
outputs and private mappings are intentionally excluded.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Security issues
must follow [SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
