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
- Bash and `jq`.

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
bash tests/setup.sh
```

`tests/smoke.sh` uses a fake `curl` implementation and does not call Ollama.
`tests/opencode-bundle.sh` uses a fake Claude executable and a temporary
configuration directory. `tests/setup.sh` drives `setup.sh` against stubs for
every external command, so it makes no network calls and never touches
the OpenCode configuration of the machine.

The real routing evaluation needs the configured Ollama model:

```bash
pnpm test:integration
```

`pnpm test` matches the deterministic CI gate. CI omits the live Ollama routing
evaluations and provider-backed benchmark execution, so it does not require
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

Route definitions belong in `config.json`, not in runtime lookup tables. Each
schema version 2 route must declare a unique ID, target agent, non-negative
integer order, complete target, all seven capabilities, and the
`acceptedMediaTypes` list that matches `canUseAttachments`. Every routing entry
must declare an `intent` and a `route` that references a declared route:

```json
{
  "intent": "translation_simple_brainstorm_docs_or_intermediate_work",
  "route": "glm"
}
```

Route capabilities remain an orthogonal eligibility filter: classification
selects a route first, then capability checks can promote it without changing
the classified intent. Attachment media types use the same filter: the manifest
list is the runtime source of truth, so routing never queries a model catalog
while a message is being handled.

Configs without `schema_version`, schema 1 configs, and schema 2 configs remain
compatible. Validate the normalized schema 2 result with:

```bash
./route --manifest --json
node --test tests/route-manifest.test.mjs
```

When route count, order, targets, or capabilities change, also run
`bash tests/opencode-bundle.sh`. That test verifies that installation generates
the required OpenCode agents and provider model entries. Keep project overrides
restrictive: `.opencode/llm-router.routes.json` may only set existing
capabilities to `false`.

The classifier's exact success contract is:

```json
{
  "schema_version": 1,
  "intent": "translation_simple_brainstorm_docs_or_intermediate_work",
  "route": "glm"
}
```

Its exact error contract uses schema 1 with only `schema_version` and `error`;
the error object contains only `code` and `message`. Any missing or extra
success field or unknown route fails closed.

When changing an OpenCode or provider contract:

1. update the implementation and focused tests;
2. update `docs/compatibility.md`;
3. run the bundle installer test;
4. update public examples that contain exact provider or agent IDs.

## Offline benchmark

`quality_eval.py` and `qeval/` implement the offline single-shot benchmark
runner. They are not installed in OpenCode and do not participate in message
routing.

Validate the benchmark configuration without provider calls:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases-v2.json \
  --output /tmp/llm-router-quality.json \
  --validate-only
```

Each route receives only the environment it declares under `headless.env`, so a
run never hands one provider the credentials of another. The published
benchmark includes methodology and artifact hashes; raw provider outputs and
private mappings are intentionally excluded. See [benchmark](../BENCHMARK.md).

## Commit and release conventions

Use Conventional Commits:

```text
feat(scope): user-visible capability
fix(scope): user-visible defect
docs(scope): documentation only
test(scope): test-only change
chore(scope): maintenance
```

The automatic release workflow derives SemVer and changelog entries from
commits since the latest stable `v*` tag after CI succeeds on `main`. Local
release commands are read-only checks. The workflow creates a release PR,
merges it with a normal merge commit, and places the annotated version tag on
that merge commit. Squash and rebase are not supported. Read
[RELEASE.md](RELEASE.md) for the permission, concurrency, failure, and recovery
contracts.

## Pull requests

Keep changes scoped and include:

- the user-visible or contract impact;
- tests run locally;
- documentation updates when behavior changes;
- compatibility notes for pinned SDK or OpenCode changes.

Read the repository-level [contribution guide](../CONTRIBUTING.md) for the full
workflow.
