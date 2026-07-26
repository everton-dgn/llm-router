# llm-router

[![CI](https://github.com/everton-dgn/llm-router/actions/workflows/ci.yml/badge.svg)](https://github.com/everton-dgn/llm-router/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Local message router for OpenCode. You keep one visible conversation while a
small local model picks MiniMax M3, GLM 5.2, Claude Opus 5, or GPT-5.6 Sol as
the worker for each message. There is no orchestrator turn and no second model
rewriting your request.

```text
your message in the router
  -> OpenCode chat.message hook
  -> local classifier on Ollama, one call, then it exits
  -> auto, adaptive, or pinned picks the destination
  -> MiniMax, GLM, Claude Agent SDK, or Codex answers in the same session
```

## Why

A full orchestration turn costs latency, money, and fidelity, because another
model rewrites what you asked. Here the classifier returns one route and exits,
and the original message reaches the native worker with its native OpenCode
capabilities.

A session carries two independent decisions. The routing mode decides when the
worker can change:

| Routing mode | Behavior |
| --- | --- |
| `auto` | Classifies every message independently |
| `adaptive` | Promotes immediately, demands evidence to downgrade |
| `pinned` | Keeps the first worker for the session |

The execution profile decides which tools the worker receives:

| Execution profile | Behavior |
| --- | --- |
| `native` | Adds no llm-router restrictions; ships as the default |
| `restricted` | Applies configured `allow`, `ask`, `deny`, and turn limits |
| `full` | Explicitly allows every tool the host exposes |

The two axes are independent, and all nine combinations are valid. Full
contracts: [routing modes](docs/routing-modes.md) and
[execution policies](docs/execution-policies.md).

## Install

You need macOS or Linux, OpenCode 1.18.4, a Node.js release inside the
`engines` range in `package.json`, Ollama running, and Claude Code installed.
On top of that, `curl`, `jq`, `git`, and `pnpm` must be in `PATH`, and
benchmarks and the Python tests also need Python 3.11 or newer through `uv`.

You need OpenAI authenticated in OpenCode, and `MINIMAX_API_KEY` and
`ZAI_API_KEY` exported in the environment that starts OpenCode. The integration
is pinned to OpenCode 1.18.4; read the
[compatibility contract](docs/compatibility.md) before upgrading OpenCode or
the provider SDKs.

```bash
git clone https://github.com/everton-dgn/llm-router.git
cd llm-router
bash setup.sh
```

`setup.sh` stops at the first missing prerequisite and names the command that
fixes it, installs the repository and bundle dependencies, installs the
OpenCode bundle, and pulls the local classifier model. It ends with the
interactive steps it will never do for you: the Claude Code login and the two
API keys.

An existing `opencode.jsonc` is merged, not replaced: comments, custom
providers, and unrelated settings stay in place, your `llm-router.policy.json`
is preserved, and every managed file it changes is copied to a timestamped
backup directory first. Running it again on an unchanged installation changes
nothing and creates no backup.

Preview the OpenCode changes with `bash setup.sh --dry-run`. Contributors who
want the test toolchain and the Git hooks add `--dev`.

Keep the clone where it is. The installed plugin stores its absolute path.

Step-by-step installation, update, and verification:
[quick start](docs/quick-start.md).

## First session

```bash
opencode .
```

The composer stays on the `router` agent and the session starts in
`adaptive + native`. Send a normal request. The notice above the answer reports
which worker took it.

```text
/router-status      show the session mode and profile
/router-pinned      keep one worker for the rest of the session
/router-restricted  apply the restricted profile's limits and permissions
```

All eight commands, with their exact effects, are in
[session commands](docs/commands.md). They run on a local provider and never
call an LLM.

## Default routes

The shipped configuration maps four classifier intents to four workers:

| Classifier intent | Route |
| --- | --- |
| `literal_read_only_no_writing` | MiniMax |
| `translation_simple_brainstorm_docs_or_intermediate_work` | GLM |
| `complex_creative_product_or_architecture` | Claude |
| `review_security_hard_engineering_or_technical_writing` | Codex |

These assignments choose a preferred worker. The seven route capabilities are
an orthogonal eligibility filter applied after classification; they do not
grant or remove OpenCode tools. Attachments pass through the same filter, and
[attachments](docs/routing-modes.md#attachments) documents every outcome.

Intents, routes, and capabilities live in `config.json`. You can add, remove,
or retarget a route without touching code; see the
[configuration reference](docs/config-reference.md).

## Privacy and costs

The classifier and the compaction summarizer run on the configured local Ollama
service. The selected worker still receives the approved message context
through its own provider, so that provider's privacy and billing terms apply.

Do not publish `opencode debug config`; it may expand environment values. Use
the agent-specific commands in
[privacy and costs](docs/privacy-and-costs.md).

## Documentation

| Document | Read it when |
| --- | --- |
| [Quick start](docs/quick-start.md) | You want the full install, update, or verification procedure |
| [Session commands](docs/commands.md) | You need to know what a `/router-*` command does |
| [Routing modes](docs/routing-modes.md) | The worker changed, or did not, and you want to know why |
| [Execution policies](docs/execution-policies.md) | You need to restrict tools, permissions, or turn limits |
| [Configuration reference](docs/config-reference.md) | You are editing `config.json` or a project override |
| [Claude Agent SDK](docs/claude.md) | You need Claude's context, attachment, or permission limits |
| [Troubleshooting](docs/troubleshooting.md) | Something failed and you want the fix |
| [Compatibility](docs/compatibility.md) | You are upgrading OpenCode, Node.js, or a provider SDK |
| [Privacy and costs](docs/privacy-and-costs.md) | You need to know what leaves the machine and who bills it |
| [Uninstall and rollback](docs/uninstall.md) | You want the bundle removed or a backup restored |
| [Development](docs/development.md) | You are changing this repository |
| [Documentation index](docs/README.md) | You want the complete map, including release documents |

## Contributing and license

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change, and report
security issues through [SECURITY.md](SECURITY.md). Licensed under the
[Apache License 2.0](LICENSE).
