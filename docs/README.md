# llm-router documentation

The primary [README](../README.md) and all public documentation in this
directory are maintained in English.

## Mental model

A session carries two separate decisions:

1. The routing mode decides when the worker can change.
2. The execution profile decides which tools and limits the worker receives.

For example, `adaptive + restricted` can move from GLM to Codex when risk
increases while preserving the tool restrictions. `pinned + native` keeps the
first worker and lets each provider operate with its native behavior.

## Using llm-router

| Document | Purpose |
| --- | --- |
| [Quick start](quick-start.md) | Install, update, and run the first commands |
| [Session commands](commands.md) | What each `/router-*` command does |
| [Routing modes](routing-modes.md) | Understand `auto`, `adaptive`, `pinned`, context, resume, and fork |
| [Troubleshooting](troubleshooting.md) | Diagnose failures and recover safely |
| [Privacy and costs](privacy-and-costs.md) | Data flow, credentials, and provider billing |
| [Uninstall and rollback](uninstall.md) | Restore a backup or remove the installed bundle |

## Configuring it

| Document | Purpose |
| --- | --- |
| [Configuration reference](config-reference.md) | `config.json`, route manifest, and project override |
| [Execution policies](execution-policies.md) | Configure `native`, `restricted`, or `full` permissions |
| [Claude Agent SDK](claude.md) | Context, attachments, subtasks, tools, and authentication |
| [Compatibility](compatibility.md) | Supported versions, operating systems, and upgrade boundaries |

## Maintaining the repository

| Document | Purpose |
| --- | --- |
| [Development](development.md) | Repository setup, validation, and contribution workflow |
| [Release](RELEASE.md) | Changelog, SemVer, tags, and GitHub Releases |
| [Public repository checklist](publication-checklist.md) | Repository controls, security reporting, and publication maintenance |
| [Benchmark](../BENCHMARK.md) | Offline methodology, results, and limitations |

The main contract implementations are:

- [`opencode/lib/adaptive_routing.mjs`](../opencode/lib/adaptive_routing.mjs)
- [`opencode/lib/direct_handoff.mjs`](../opencode/lib/direct_handoff.mjs)
- [`opencode/lib/execution_policy.mjs`](../opencode/lib/execution_policy.mjs)
- [`opencode/lib/router_control.mjs`](../opencode/lib/router_control.mjs)
- [`opencode/plugins/llm_router_handoff.ts`](../opencode/plugins/llm_router_handoff.ts)
- [`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json)
