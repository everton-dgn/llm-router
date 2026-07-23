# Development

## Repository layout

| Path | Responsibility |
| --- | --- |
| `route` | Local classifier and compaction summarizer entrypoint |
| `config.json` | Ollama jobs, intents, routes, and model settings |
| `opencode/` | Installable OpenCode bundle |
| `opencode/lib/` | Routing, context, policy, and transport contracts |
| `opencode/providers/` | Local Claude and router-control providers |
| `opencode/plugins/` | OpenCode handoff plugin |
| `qeval/` | Offline benchmark engine |
| `tests/` | Deterministic Node, Python, shell, and routing tests |
| `scripts/` | Repository validation and local release tooling |

## Toolchain

- Node.js 22.22.2 or 24.15.0, both validated in CI;
- pnpm through Corepack;
- Python 3.11 or newer through `uv`;
- Bash, `jq`, and `trash`.

Install repository tooling and Git hooks, then install the OpenCode bundle
dependencies:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm --dir opencode install --frozen-lockfile --no-optional
```

The root development dependencies provide Commitlint and Lefthook. If package
lifecycle scripts were disabled, install the hooks explicitly:

```bash
pnpm hooks:install
```

## Validation

Run the repository gate:

```bash
pnpm test
```

Run focused suites while developing:

```bash
node --test tests/router-handoff.test.mjs
node --test tests/execution-policy.test.mjs
node --test tests/router-control.test.mjs
node --test tests/claude-agent.test.mjs
node --test tests/claude-agent-provider.test.mjs
node --test tests/repo-query.test.mjs
```

```bash
uv run --no-project --no-python-downloads python -m unittest \
  tests/test_stage_verifier.py tests/test_quality_eval.py
```

```bash
bash tests/smoke.sh
bash tests/opencode-bundle.sh
```

`tests/smoke.sh` uses a fake `curl` implementation and does not call Ollama.
`tests/opencode-bundle.sh` uses a fake Claude executable and a temporary
configuration directory.

The real routing evaluation needs the configured Ollama model:

```bash
pnpm test:integration
```

`pnpm test` matches the deterministic CI gate. CI omits the live Ollama routing
evaluation and provider-backed benchmark execution, so it does not require
MiniMax, Z.AI, Anthropic, or OpenAI credentials.

## Local Git hooks

Lefthook uses staged-file globs during `pre-commit`:

| Changed files | Focused check |
| --- | --- |
| Release scripts or root package metadata | `pnpm test:release` |
| Hook configuration or root package metadata | `pnpm hooks:check` |
| Markdown documentation | Documentation links and JSON examples |
| OpenCode JavaScript, TypeScript, or configuration | `pnpm test:node` |
| Router, installer, or shell tests | `pnpm test:shell` |
| Python, benchmark, or quality-case files | `pnpm test:python` |

The `commit-msg` hook runs Commitlint. The `pre-push` hook runs the same
deterministic `pnpm test` gate used by CI. Live Ollama integration remains
explicit because it requires a local service and model.

## Change boundaries

Routing and execution policy are separate contracts. A change to route
selection must preserve the active execution profile. A policy change must not
silently change the session's routing mode.

When changing an OpenCode or provider contract:

1. update the implementation and focused tests;
2. update `docs/compatibility.md`;
3. run the bundle installer test;
4. update public examples that contain exact provider or agent IDs.

## Commit and release conventions

Use Conventional Commits:

```text
feat(scope): user-visible capability
fix(scope): user-visible defect
docs(scope): documentation only
test(scope): test-only change
chore(scope): maintenance
```

The local release scripts derive SemVer from commits since the latest stable
`v*` tag. Read [RELEASE.md](RELEASE.md) before preparing a changelog entry or
cutting a release.

## Pull requests

Keep changes scoped and include:

- the user-visible or contract impact;
- tests run locally;
- documentation updates when behavior changes;
- compatibility notes for pinned SDK or OpenCode changes.

Read the repository-level [contribution guide](../CONTRIBUTING.md) for the full
workflow.
