#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INSTALLER="$REPO_ROOT/opencode/install.sh"
POLICY="$REPO_ROOT/opencode/lib/routing_policy.mjs"
CONTRACT="$REPO_ROOT/opencode/lib/route_contract.mjs"
STAGE_TOOLS="$REPO_ROOT/opencode/lib/stage_tools.mjs"
TRASH_PATH=$(command -v trash || true)
NODE_PATH=$(command -v node || true)
BUN_PATH=$(command -v bun || true)
[[ -n "$TRASH_PATH" ]] || { printf 'FAIL: trash is required\n' >&2; exit 1; }
[[ -n "$NODE_PATH" ]] || { printf 'FAIL: node is required\n' >&2; exit 1; }
[[ -n "$BUN_PATH" ]] || { printf 'FAIL: bun is required\n' >&2; exit 1; }

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-opencode-test.XXXXXX")
cleanup() {
  [[ ! -d "$FIXTURE" ]] || "$TRASH_PATH" "$FIXTURE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file=$1
  local expected=$2
  grep -F "$expected" "$file" >/dev/null || fail "$file does not contain: $expected"
}

assert_not_contains() {
  local file=$1
  local unexpected=$2
  if grep -F "$unexpected" "$file" >/dev/null; then
    fail "$file unexpectedly contains: $unexpected"
  fi
}

bash -n "$INSTALLER"
bash -n "$0"

if grep -E '(^|[[:space:]])(rm|rmdir|unlink)([[:space:]]|$)' "$INSTALLER" >/dev/null; then
  fail "installer contains a permanently destructive command"
fi

CONFIG_TEMPLATE="$REPO_ROOT/opencode/opencode.jsonc"
assert_contains "$CONFIG_TEMPLATE" '"disabled_providers": ["github-copilot", "opencode-go"]'
assert_contains "$CONFIG_TEMPLATE" '"whitelist": ["MiniMax-M3"]'
assert_contains "$CONFIG_TEMPLATE" '"model": "openai/gpt-5.6-sol"'
assert_contains "$CONFIG_TEMPLATE" '"reasoningEffort": "xhigh"'
assert_contains "$CONFIG_TEMPLATE" '"textVerbosity": "medium"'
assert_contains "$CONFIG_TEMPLATE" '"mode": "subagent"'
assert_contains "$CONFIG_TEMPLATE" '"claude_agent": "allow"'
assert_contains "$CONFIG_TEMPLATE" '"stage_prepare": "allow"'
assert_contains "$CONFIG_TEMPLATE" '"stage_verify": "allow"'
assert_contains "$CONFIG_TEMPLATE" '"minimax": "allow"'
assert_contains "$CONFIG_TEMPLATE" '"codex-reviewer": "allow"'
assert_contains "$CONFIG_TEMPLATE" 'Pass only the stage argument to llm_route'
assert_contains "$CONFIG_TEMPLATE" "do not add a request argument"
assert_contains "$CONFIG_TEMPLATE" 'never use an LLM jury'
jq -e '.agent.minimax.permission == {"*":"deny","repo_query":"allow"}' "$CONFIG_TEMPLATE" >/dev/null || fail "MiniMax permissions are not read-only"
jq -e '.agent["codex-reviewer"].permission == {"*":"deny","repo_query":"allow"}' "$CONFIG_TEMPLATE" >/dev/null || fail "reviewer permissions are not read-only"

[[ ! -e "$REPO_ROOT/opencode/tools/delegate_task.ts" ]] || fail "legacy delegate_task tool still exists"
[[ ! -e "$REPO_ROOT/opencode/tools/claude_opus.ts" ]] || fail "legacy claude_opus tool still exists"
assert_contains "$REPO_ROOT/opencode/tools/llm_route.ts" '"--classify", "--json"'
assert_contains "$REPO_ROOT/opencode/tools/llm_route.ts" 'if (args.stage === "review")'
assert_contains "$REPO_ROOT/opencode/tools/claude_agent.ts" '@anthropic-ai/claude-agent-sdk'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'if (effort === "xhigh") return "xhigh"'
assert_contains "$REPO_ROOT/opencode/tools/stage_verify.ts" 'baseline_id'
assert_contains "$REPO_ROOT/opencode/tools/stage_prepare.ts" 'prepareStagePayload(context.worktree'
assert_contains "$REPO_ROOT/opencode/lib/prompt_guard.mjs" 'export function requireRouterRequest(sessionID)'
assert_contains "$REPO_ROOT/opencode/tools/llm_route.ts" 'requireRouterRequest(context.sessionID)'
assert_not_contains "$REPO_ROOT/opencode/lib/prompt_guard.mjs" 'tool.execute.before'
assert_contains "$REPO_ROOT/opencode/tools/repo_query.ts" 'runRepositoryQuery(args, context.worktree)'
[[ ! -e "$REPO_ROOT/opencode/plugins/llm_router_prompt_guard.js" ]] || fail "CommonJS-sensitive prompt guard still exists"

"$NODE_PATH" --input-type=module - "$POLICY" "$CONTRACT" "$STAGE_TOOLS" <<'NODE'
import { pathToFileURL } from "node:url"

const policy = await import(pathToFileURL(process.argv[2]))
const contract = await import(pathToFileURL(process.argv[3]))
const stageTools = await import(pathToFileURL(process.argv[4]))

if (JSON.stringify(stageTools.verifyStagePayload("a".repeat(32))) !== JSON.stringify({ baseline_id: "a".repeat(32) })) {
  throw new Error("verify payload must contain only baseline_id")
}

const routeCases = [
  ["minimax", "request", "crie router-proof.txt com conteúdo exato", "glm"],
  ["minimax", "request", "quantos arquivos existem no projeto?", "minimax"],
  ["minimax", "request", "conte os arquivos. Não altere arquivos.", "minimax"],
  ["minimax", "request", "conte os arquivos. Não deve alterar arquivos.", "minimax"],
  ["minimax", "request", "count the files. Do not modify files.", "minimax"],
  ["minimax", "request", "count the files. You must not modify files.", "minimax"],
  ["minimax", "request", "crie o relatório. Não altere os testes.", "glm"],
  ["minimax", "request", "traduza esta mensagem para português", "glm"],
  ["minimax", "request", "resuma este log em uma frase", "glm"],
  ["codex", "plan", "planeje e implemente uma correção complexa", "claude"],
  ["claude", "execute", "implemente a arquitetura do produto", "codex"],
]
for (const [route, stage, request, expected] of routeCases) {
  const actual = policy.enforceMinimumRoute(route, stage, request)
  if (actual !== expected) throw new Error(`${request}: expected ${expected}, received ${actual}`)
}

if (policy.selectClaudeEffort("request", "Discuta os trade-offs.") !== "xhigh") {
  throw new Error("open discussion should use xhigh")
}
if (policy.selectClaudeEffort("plan", "Defina a estratégia.") !== "max") {
  throw new Error("planning should use max")
}
if (policy.routeTarget("glm").subagent_type !== "glm") {
  throw new Error("GLM target is not a native task")
}
if (policy.routeTarget("claude").tool !== "claude_agent") {
  throw new Error("Claude target is not the SDK tool")
}
if (policy.executionPolicy("minimax").escalate_to !== "glm") {
  throw new Error("MiniMax escalation is invalid")
}

const parsed = contract.parseClassifierResult(JSON.stringify({
  schema_version: 1,
  intent: "literal_read_only_no_writing",
  route: "minimax",
}))
if (parsed.route !== "minimax") throw new Error("valid classifier result was not parsed")

for (const invalid of [
  "not-json",
  JSON.stringify({ schema_version: 2, intent: "x", route: "glm" }),
  JSON.stringify({ schema_version: 1, intent: "x", route: "other" }),
  JSON.stringify({ schema_version: 1, intent: "x", route: "glm", extra: true }),
]) {
  let rejected = false
  try {
    contract.parseClassifierResult(invalid)
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error(`invalid classifier result was accepted: ${invalid}`)
}
NODE

CONFIG_DIR="$FIXTURE/config"
BACKUP_ROOT="$FIXTURE/backups"
mkdir -p "$CONFIG_DIR/tools" "$CONFIG_DIR/plugins"
printf '%s\n' '{"previous":true}' | tee "$CONFIG_DIR/opencode.jsonc" >/dev/null
printf '%s\n' '{"private":true,"type":"commonjs","dependencies":{"user-package":"7.0.0","@opencode-ai/plugin":"0.1.0"},"scripts":{"keep":"true"}}' | tee "$CONFIG_DIR/package.json" >/dev/null
printf '%s\n' 'legacy claude tool' | tee "$CONFIG_DIR/tools/claude_opus.ts" >/dev/null
printf '%s\n' 'legacy delegate tool' | tee "$CONFIG_DIR/tools/delegate_task.ts" >/dev/null
printf '%s\n' 'legacy prompt guard' | tee "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" >/dev/null
BEFORE_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc" "$CONFIG_DIR/package.json")

DRY_RUN_OUTPUT=$(bash "$INSTALLER" \
  --dry-run \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route")

AFTER_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc" "$CONFIG_DIR/package.json")
[[ "$BEFORE_DRY_RUN" == "$AFTER_DRY_RUN" ]] || fail "dry-run modified target files"
[[ -e "$CONFIG_DIR/tools/claude_opus.ts" ]] || fail "dry-run retired claude_opus"
[[ -e "$CONFIG_DIR/tools/delegate_task.ts" ]] || fail "dry-run retired delegate_task"
[[ -e "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" ]] || fail "dry-run retired legacy prompt guard"
[[ ! -e "$BACKUP_ROOT" ]] || fail "dry-run created a backup directory"
[[ "$DRY_RUN_OUTPUT" == *"would retire $CONFIG_DIR/tools/claude_opus.ts (with backup)"* ]] || fail "dry-run did not report claude_opus retirement"
[[ "$DRY_RUN_OUTPUT" == *"would retire $CONFIG_DIR/tools/delegate_task.ts (with backup)"* ]] || fail "dry-run did not report delegate_task retirement"

FIRST_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route")

cmp -s "$CONFIG_TEMPLATE" "$CONFIG_DIR/opencode.jsonc" || fail "installed config differs from template"
cmp -s "$REPO_ROOT/config.json" "$CONFIG_DIR/lib/llm-router-config.json" || fail "installed router config differs"
cmp -s "$REPO_ROOT/stage_verifier.py" "$CONFIG_DIR/lib/stage_verifier.py" || fail "installed stage verifier differs"
assert_contains "$CONFIG_DIR/tools/llm_route.ts" "const ROUTER_PATH = \"$REPO_ROOT/route\""
assert_contains "$CONFIG_DIR/tools/llm_route.ts" 'const ROUTER_TIMEOUT_MS = 120_000'
assert_contains "$CONFIG_DIR/tools/claude_agent.ts" '@anthropic-ai/claude-agent-sdk'
assert_contains "$CONFIG_DIR/tools/repo_query.ts" 'runRepositoryQuery(args, context.worktree)'
assert_contains "$CONFIG_DIR/tools/stage_prepare.ts" "const CONFIG_PATH = \"$CONFIG_DIR/lib/llm-router-config.json\""
assert_contains "$CONFIG_DIR/lib/stage_tools.mjs" "const STAGE_VERIFIER_PATH = \"$CONFIG_DIR/lib/stage_verifier.py\""
cmp -s "$REPO_ROOT/opencode/plugins/llm_router_prompt_guard.ts" "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" || fail "installed prompt guard differs"
[[ ! -e "$CONFIG_DIR/tools/claude_opus.ts" ]] || fail "legacy claude_opus was not retired"
[[ ! -e "$CONFIG_DIR/tools/delegate_task.ts" ]] || fail "legacy delegate_task was not retired"
[[ ! -e "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" ]] || fail "legacy prompt guard was not retired"

jq -e '.dependencies["user-package"] == "7.0.0"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user dependency"
jq -e '.scripts.keep == "true"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user script"
jq -e '.type == "commonjs"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge changed the user module type"
jq -e '.dependencies["@opencode-ai/plugin"] == "1.18.4"' "$CONFIG_DIR/package.json" >/dev/null || fail "plugin dependency was not pinned"
jq -e '.dependencies["@anthropic-ai/claude-agent-sdk"] == "0.3.216"' "$CONFIG_DIR/package.json" >/dev/null || fail "Claude SDK dependency was not installed"

PROJECT_DIR="$FIXTURE/project"
mkdir -p "$PROJECT_DIR"
git -C "$PROJECT_DIR" init -q
printf '%s\n' 'before' | tee "$PROJECT_DIR/tracked.txt" >/dev/null
git -C "$PROJECT_DIR" add tracked.txt
git -C "$PROJECT_DIR" -c user.name='Bundle Test' -c user.email='bundle@example.invalid' commit -q -m initial
STAGE_SCRIPT="$FIXTURE/stage-tools-test.mjs"
tee "$STAGE_SCRIPT" >/dev/null <<'STAGE_TEST'
import { appendFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const [helperPath, projectRoot, configPath, logPath] = process.argv.slice(2)
const { runStageVerifier } = await import(pathToFileURL(helperPath))
const context = {
  directory: `${projectRoot}/subdirectory`,
  worktree: projectRoot,
  abort: new AbortController().signal,
}
const prepared = await runStageVerifier("prepare", {
  project_root: projectRoot,
  config_path: configPath,
  log_path: logPath,
}, context, 30_000)
if (prepared.status !== "prepared" || !/^[a-f0-9]{32}$/.test(prepared.baseline_id)) {
  throw new Error(`unexpected prepare result: ${JSON.stringify(prepared)}`)
}
await appendFile(`${projectRoot}/tracked.txt`, "after\n")
const verified = await runStageVerifier("verify", {
  baseline_id: prepared.baseline_id,
}, context, 30_000)
if (verified.status !== "no_applicable_gates") {
  throw new Error(`unexpected verify result: ${JSON.stringify(verified)}`)
}
if (JSON.stringify(verified.changed_files) !== JSON.stringify(["tracked.txt"])) {
  throw new Error(`unexpected changed files: ${JSON.stringify(verified.changed_files)}`)
}
STAGE_TEST
mkdir -p "$PROJECT_DIR/subdirectory"
"$BUN_PATH" "$STAGE_SCRIPT" \
  "$CONFIG_DIR/lib/stage_tools.mjs" \
  "$PROJECT_DIR" \
  "$CONFIG_DIR/lib/llm-router-config.json" \
  "$FIXTURE/stage-events.jsonl"

if grep -R -E '__[A-Z0-9_]+__' "$CONFIG_DIR" >/dev/null; then
  fail "installed bundle contains an unresolved placeholder"
fi

BACKUP_CONFIG=$(find "$BACKUP_ROOT" -type f -name opencode.jsonc -print)
BACKUP_CLAUDE=$(find "$BACKUP_ROOT" -type f -name claude_opus.ts -print)
BACKUP_DELEGATE=$(find "$BACKUP_ROOT" -type f -name delegate_task.ts -print)
BACKUP_PROMPT_GUARD=$(find "$BACKUP_ROOT" -type f -name llm_router_prompt_guard.js -print)
[[ -n "$BACKUP_CONFIG" ]] || fail "changed config was not backed up"
[[ -n "$BACKUP_CLAUDE" ]] || fail "retired claude_opus was not backed up"
[[ -n "$BACKUP_DELEGATE" ]] || fail "retired delegate_task was not backed up"
[[ -n "$BACKUP_PROMPT_GUARD" ]] || fail "retired prompt guard was not backed up"
assert_contains "$BACKUP_CONFIG" '{"previous":true}'
[[ "$(stat -f '%Lp' "$BACKUP_ROOT")" == "700" ]] || fail "backup root permissions are not 0700"
[[ "$(stat -f '%Lp' "$(dirname "$BACKUP_CONFIG")")" == "700" ]] || fail "timestamped backup permissions are not 0700"
[[ "$(stat -f '%Lp' "$BACKUP_CONFIG")" == "600" ]] || fail "backup file permissions are not 0600"
BACKUP_COUNT_BEFORE=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')

SECOND_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route")

BACKUP_COUNT_AFTER=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
[[ "$BACKUP_COUNT_BEFORE" == "$BACKUP_COUNT_AFTER" ]] || fail "idempotent install created another backup"
[[ "$SECOND_OUTPUT" == *"unchanged $CONFIG_DIR/opencode.jsonc"* ]] || fail "idempotent install did not report unchanged config"
[[ "$SECOND_OUTPUT" == *"unchanged $CONFIG_DIR/package.json"* ]] || fail "idempotent install did not report unchanged package"
[[ "$FIRST_OUTPUT" == *"backup $BACKUP_ROOT/"* ]] || fail "first install did not report its backup"

ATOMIC_CONFIG="$FIXTURE/atomic-config"
mkdir -p "$ATOMIC_CONFIG/tools"
printf '%s\n' '{"sentinel":"config"}' | tee "$ATOMIC_CONFIG/opencode.jsonc" >/dev/null
printf '%s\n' '{"sentinel":"package"}' | tee "$ATOMIC_CONFIG/package.json" >/dev/null
printf '%s\n' 'symlink target' | tee "$FIXTURE/late-target" >/dev/null
ln -s "$FIXTURE/late-target" "$ATOMIC_CONFIG/tools/stage_verify.ts"
ATOMIC_BEFORE=$(shasum -a 256 "$ATOMIC_CONFIG/opencode.jsonc" "$ATOMIC_CONFIG/package.json")
if bash "$INSTALLER" --config-dir "$ATOMIC_CONFIG" --backup-root "$FIXTURE/atomic-backups" --router-path "$REPO_ROOT/route" >/dev/null 2>&1; then
  fail "installer accepted a late symlink target"
fi
ATOMIC_AFTER=$(shasum -a 256 "$ATOMIC_CONFIG/opencode.jsonc" "$ATOMIC_CONFIG/package.json")
[[ "$ATOMIC_BEFORE" == "$ATOMIC_AFTER" ]] || fail "preflight failure partially changed the active bundle"
[[ ! -e "$FIXTURE/atomic-backups" ]] || fail "preflight failure created backups"

RELATIVE_ROUTE="$FIXTURE/relative-route"
cp "$REPO_ROOT/route" "$RELATIVE_ROUTE"
chmod +x "$RELATIVE_ROUTE"
(
  cd "$FIXTURE"
  bash "$INSTALLER" --config-dir relative-config --backup-root relative-backups --router-path relative-route >/dev/null
)
RELATIVE_ROOT=$(cd "$FIXTURE" && pwd)
assert_contains "$FIXTURE/relative-config/tools/llm_route.ts" "const ROUTER_PATH = \"$RELATIVE_ROOT/relative-route\""
assert_contains "$FIXTURE/relative-config/tools/stage_prepare.ts" "const CONFIG_PATH = \"$RELATIVE_ROOT/relative-config/lib/llm-router-config.json\""

printf 'PASS: native OpenCode tasks, safe repository queries, Claude SDK, JSON routing, verifier bundle, atomic install, backup, retirement, and idempotence\n'
