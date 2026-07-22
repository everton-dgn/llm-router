#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INSTALLER="$REPO_ROOT/opencode/install.sh"
POLICY="$REPO_ROOT/opencode/lib/routing_policy.mjs"
CONTRACT="$REPO_ROOT/opencode/lib/route_contract.mjs"
CHECKPOINT="$REPO_ROOT/opencode/lib/claude_checkpoint.mjs"
SESSION_METADATA="$REPO_ROOT/opencode/lib/session_metadata.mjs"
VERIFICATION_CONFIG="$REPO_ROOT/config.json"
TRASH_PATH=$(command -v trash || true)
NODE_PATH=$(command -v node || true)
[[ -n "$TRASH_PATH" ]] || { printf 'FAIL: trash is required\n' >&2; exit 1; }
[[ -n "$NODE_PATH" ]] || { printf 'FAIL: node is required\n' >&2; exit 1; }

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-opencode-test.XXXXXX")
FIXTURE=$(cd "$FIXTURE" && pwd)
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
    fail "$file still contains: $unexpected"
  fi
}

write_compatible_claude() {
  local target=$1
  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "--help" ]; then' \
    '  printf "%s\n" \' \
    '    "  -p, --print" \' \
    '    "  --input-format <format>" \' \
    '    "  --output-format <format>" \' \
    '    "  --verbose" \' \
    '    "  --include-partial-messages" \' \
    '    "  --model <model>" \' \
    '    "  --permission-mode <mode>" \' \
    '    "  --safe-mode" \' \
    '    "  --tools <tools...>" \' \
    '    "  --strict-mcp-config" \' \
    '    "  --mcp-config <configs...>" \' \
    '    "  --disable-slash-commands" \' \
    '    "  --no-chrome" \' \
    '    "  --no-session-persistence" \' \
    '    "  --system-prompt <prompt>"' \
    '  exit 0' \
    'fi' \
    'exit 0' | tee "$target" >/dev/null
  chmod +x "$target"
}

write_tty_only_claude() {
  local target=$1
  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "--help" ]; then' \
    '  if [ -t 1 ]; then' \
    '    printf "%s\n" "Usage: claude [options]"' \
    '    printf "%s\n" \' \
    '      "  -p, --print" \' \
    '      "  --input-format <format>" \' \
    '      "  --output-format <format>" \' \
    '      "  --verbose" \' \
    '      "  --include-partial-messages" \' \
    '      "  --model <model>" \' \
    '      "  --permission-mode <mode>" \' \
    '      "  --safe-mode" \' \
    '      "  --tools <tools...>" \' \
    '      "  --strict-mcp-config" \' \
    '      "  --mcp-config <configs...>" \' \
    '      "  --disable-slash-commands" \' \
    '      "  --no-chrome" \' \
    '      "  --no-session-persistence" \' \
    '      "  --system-prompt <prompt>"' \
    '  else' \
    '    printf "%s\n" "Usage: claude [options]" "  --agents <json>"' \
    '  fi' \
    '  exit 0' \
    'fi' \
    'exit 0' | tee "$target" >/dev/null
  chmod +x "$target"
}

bash -n "$INSTALLER"
bash -n "$0"

if grep -E '(^|[[:space:]])(rm|rmdir|unlink)([[:space:]]|$)' "$INSTALLER" >/dev/null; then
  fail "installer contains a permanently destructive command"
fi

CONFIG_TEMPLATE="$REPO_ROOT/opencode/opencode.jsonc"
jq empty "$CONFIG_TEMPLATE"
jq -e '
  .model == "ollama/hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M"
  and .default_agent == "router-auto"
  and .agent["router-auto"].mode == "primary"
  and .agent["router-auto"].model == .model
  and .agent["router-auto"].permission == {"*":"deny"}
  and .agent["router-manual"].mode == "primary"
  and .agent["router-manual"].model == .model
  and .agent["router-manual"].permission == {"*":"deny"}
  and .agent.minimax.mode == "subagent"
  and .agent.glm.mode == "subagent"
  and .agent.claude.mode == "subagent"
  and .agent.codex.mode == "subagent"
  and .agent.claude.model == "claude-agent/claude-opus-4-8"
  and .agent.claude.permission == {"*":"deny"}
  and .provider["claude-agent"].npm == "__CLAUDE_AGENT_PROVIDER_URL__"
  and .provider["claude-agent"].name == "Claude CLI"
  and .provider["claude-agent"].options.claudePath == "__CLAUDE_CODE_PATH__"
  and .provider["claude-agent"].models["claude-opus-4-8"].limit == {"context":200000,"output":32000}
  and .agent.codex.model == "openai/gpt-5.6-sol"
  and (.agent | keys | sort) == ["claude", "codex", "glm", "minimax", "router-auto", "router-manual"]
' "$CONFIG_TEMPLATE" >/dev/null || fail "direct handoff config is invalid"

for removed in \
  opencode/tools/llm_route.ts \
  opencode/tools/claude_agent.ts \
  opencode/tools/stage_prepare.ts \
  opencode/tools/stage_verify.ts \
  opencode/lib/prompt_guard.mjs \
  opencode/lib/stage_tools.mjs \
  opencode/plugins/llm_router_prompt_guard.ts; do
  [[ ! -e "$REPO_ROOT/$removed" ]] || fail "retired orchestration file still exists: $removed"
done

assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"--classify", "--json", "--", request'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'client.tui.showToast'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'createDirectModelHandoff({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'createOpenCodeV2ClientFromLegacyTransport({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'client: v2Client,'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'v2Client.v2.session.context('
assert_not_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'v2Client.session.messages('
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'CHECKPOINT_TIMEOUT_MS = 30_000'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'unwrapOpenCodeV2Context(response)'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"--summarize", "--json"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'updateSessionMetadata({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"Auto"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"Manual fixado"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"Manual reutilizado"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'output.options.cwd = worktree || directory'
if grep -E 'persistDirectModelSelection|switchModel' \
  "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" >/dev/null; then
  fail "handoff plugin still persists the composer selection"
fi
assert_contains "$REPO_ROOT/opencode/lib/opencode_transport.mjs" 'const transport = legacyClient?._client'
assert_contains "$REPO_ROOT/opencode/lib/opencode_transport.mjs" 'fetch: config.fetch'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'output.message.agent = selection.target.agent'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'output.message.model = {'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'MANUAL_TARGET_METADATA_KEY'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'updateSessionMetadata({'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" '{ sessionID, agent: "router-manual" }'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message?.type === "user"'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message?.type !== "assistant"'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message.error !== undefined'
[[ -f "$CHECKPOINT" ]] || fail "safe Claude checkpoint module is missing"
[[ -f "$SESSION_METADATA" ]] || fail "serialized session metadata module is missing"
assert_contains "$SESSION_METADATA" 'updatesBySession'
assert_contains "$CHECKPOINT" 'CLAUDE_CHECKPOINT_METADATA_KEY'
assert_contains "$CHECKPOINT" 'createClaudeCheckpointLifecycle'
assert_contains "$CHECKPOINT" 'response?.data?.data'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'specificationVersion: "v3"'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'CLAUDE_MAX_INPUT_BYTES = 2 * 1024 * 1024'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'maxOutputBytes'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'from "node:child_process"'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" '"--output-format",'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" '"--tools",'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" '"--safe-mode",'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" '"--no-session-persistence",'
assert_contains "$REPO_ROOT/opencode/tools/repo_query.ts" 'runRepositoryQuery(args, context.worktree)'
assert_not_contains "$REPO_ROOT/README.md" 'somente a última mensagem do usuário'
assert_not_contains "$REPO_ROOT/README.md" 'como um teto conservador de bytes UTF-8'
assert_not_contains "$REPO_ROOT/README.md" 'Instala as dependências pinadas'
jq -e '.dependencies == {"@opencode-ai/plugin":"1.18.4","@opencode-ai/sdk":"1.18.4"}' "$REPO_ROOT/opencode/package.json" >/dev/null || fail "bundle dependencies are not pinned"
jq -e '
  .verification.rules[]
  | select(.name == "llm-router-opencode-tests")
  | .gates[]
  | select(.type == "command" and .argv[0:2] == ["node", "--test"])
  | (.argv | index("tests/router-handoff.test.mjs")) != null
    and (.argv | index("tests/claude-agent.test.mjs")) != null
    and (.argv | index("tests/claude-agent-provider.test.mjs")) != null
    and (.argv | index("tests/repo-query.test.mjs")) != null
    and (.argv | index("tests/router-prompt-guard.test.mjs")) == null
' "$VERIFICATION_CONFIG" >/dev/null || fail "OpenCode verification gate does not run the current Node test suite"

"$NODE_PATH" --input-type=module - "$REPO_ROOT/opencode/lib/opencode_transport.mjs" <<'NODE'
import { pathToFileURL } from "node:url"

const { createOpenCodeV2ClientFromLegacyTransport } = await import(pathToFileURL(process.argv[2]))
const inProcessFetch = () => {}
const expectedClient = { session: {} }
let received
const actualClient = createOpenCodeV2ClientFromLegacyTransport({
  legacyClient: {
    _client: {
      getConfig: () => ({
        baseUrl: "http://opencode.internal",
        headers: { authorization: "test" },
        fetch: inProcessFetch,
      }),
    },
  },
  createV2Client: (config) => {
    received = config
    return expectedClient
  },
  directory: "/workspace",
})
if (actualClient !== expectedClient) throw new Error("shim did not return the v2 client")
if (received.baseUrl !== "http://opencode.internal") throw new Error("shim lost baseUrl")
if (received.fetch !== inProcessFetch) throw new Error("shim lost in-process fetch")
if (received.directory !== "/workspace") throw new Error("shim lost directory")
NODE

"$NODE_PATH" --input-type=module - "$POLICY" "$CONTRACT" <<'NODE'
import { pathToFileURL } from "node:url"

const policy = await import(pathToFileURL(process.argv[2]))
const contract = await import(pathToFileURL(process.argv[3]))

const routeCases = [
  ["minimax", "crie router-proof.txt com conteúdo exato", "glm"],
  ["minimax", "quantos arquivos existem no projeto?", "minimax"],
  ["minimax", "conte os arquivos. Não altere arquivos.", "minimax"],
  ["minimax", "traduza esta mensagem para português", "glm"],
  ["claude", "planeje uma arquitetura", "claude"],
  ["claude", "corrija uma condição de corrida", "codex"],
  ["claude", "analise, mas não altere nenhum arquivo", "claude"],
  ["codex", "corrija uma condição de corrida", "codex"],
]
for (const [route, request, expected] of routeCases) {
  const actual = policy.enforceMinimumRoute(route, request)
  if (actual !== expected) throw new Error(`${request}: expected ${expected}, received ${actual}`)
}

const claude = policy.routeTarget("claude")
if (JSON.stringify(claude) !== JSON.stringify({
  agent: "claude",
  providerID: "claude-agent",
  modelID: "claude-opus-4-8",
})) throw new Error("Claude target is not the local CLI provider")

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
CLAUDE_PATH="$FIXTURE/claude"
write_compatible_claude "$CLAUDE_PATH"

TTY_ONLY_CLAUDE="$FIXTURE/tty-only-claude"
write_tty_only_claude "$TTY_ONLY_CLAUDE"
if "$TTY_ONLY_CLAUDE" --help | grep -F -- '--safe-mode' >/dev/null; then
  fail "TTY-only Claude fixture exposed the complete help through a pipe"
fi
bash "$INSTALLER" \
  --dry-run \
  --config-dir "$FIXTURE/tty-help-config" \
  --backup-root "$FIXTURE/tty-help-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$TTY_ONLY_CLAUDE" >/dev/null \
  || fail "installer rejected Claude flags that are visible only in a TTY"
[[ ! -e "$FIXTURE/tty-help-config" ]] || fail "TTY help dry-run created target config"
[[ ! -e "$FIXTURE/tty-help-backups" ]] || fail "TTY help dry-run created backups"

INCOMPATIBLE_CLAUDE="$FIXTURE/incompatible-claude"
printf '%s\n' \
  '#!/bin/sh' \
  'if [ "${1:-}" = "--help" ]; then' \
  '  printf "%s\n" "--print --input-format --output-format"' \
  '  exit 0' \
  'fi' \
  'exit 0' | tee "$INCOMPATIBLE_CLAUDE" >/dev/null
chmod +x "$INCOMPATIBLE_CLAUDE"
if INCOMPATIBLE_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$FIXTURE/incompatible-config" \
  --backup-root "$FIXTURE/incompatible-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$INCOMPATIBLE_CLAUDE" 2>&1); then
  fail "installer accepted a Claude CLI without all required flags"
fi
[[ "$INCOMPATIBLE_OUTPUT" == *"does not support required flag"* ]] \
  || fail "incompatible Claude CLI did not report the missing flag"
[[ ! -e "$FIXTURE/incompatible-config" ]] \
  || fail "incompatible Claude CLI created the target config"
[[ ! -e "$FIXTURE/incompatible-backups" ]] \
  || fail "incompatible Claude CLI created backups"

mkdir -p "$CONFIG_DIR/tools" "$CONFIG_DIR/plugins" "$CONFIG_DIR/lib" "$CONFIG_DIR/providers"
printf '%s\n' '{"previous":true}' | tee "$CONFIG_DIR/opencode.jsonc" >/dev/null
printf '%s\n' '{"private":true,"dependencies":{"user-package":"7.0.0","@anthropic-ai/claude-agent-sdk":"0.3.100","@opencode-ai/plugin":"0.1.0","@opencode-ai/sdk":"0.1.0"},"scripts":{"keep":"true"}}' | tee "$CONFIG_DIR/package.json" >/dev/null
printf '%s\n' 'stale helper' | tee "$CONFIG_DIR/lib/claude_agent.mjs" >/dev/null
for legacy in \
  "$CONFIG_DIR/tools/llm_route.ts" \
  "$CONFIG_DIR/tools/claude_agent.ts" \
  "$CONFIG_DIR/tools/stage_prepare.ts" \
  "$CONFIG_DIR/tools/stage_verify.ts" \
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" \
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" \
  "$CONFIG_DIR/lib/prompt_guard.mjs" \
  "$CONFIG_DIR/lib/stage_tools.mjs"; do
  printf '%s\n' legacy | tee "$legacy" >/dev/null
done
BEFORE_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc" "$CONFIG_DIR/package.json")

DRY_RUN_OUTPUT=$(bash "$INSTALLER" \
  --dry-run \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH")

AFTER_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc" "$CONFIG_DIR/package.json")
[[ "$BEFORE_DRY_RUN" == "$AFTER_DRY_RUN" ]] || fail "dry-run modified target files"
[[ -e "$CONFIG_DIR/tools/llm_route.ts" ]] || fail "dry-run retired llm_route"
[[ ! -e "$BACKUP_ROOT" ]] || fail "dry-run created a backup directory"
[[ "$DRY_RUN_OUTPUT" == *"would retire $CONFIG_DIR/tools/llm_route.ts (with backup)"* ]] || fail "dry-run did not report llm_route retirement"

FIRST_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH")

assert_contains "$CONFIG_DIR/plugins/llm_router_handoff.ts" "const ROUTER_PATH = \"$REPO_ROOT/route\""
cmp -s "$REPO_ROOT/opencode/lib/direct_handoff.mjs" "$CONFIG_DIR/lib/direct_handoff.mjs" || fail "installed handoff helper differs"
cmp -s "$REPO_ROOT/opencode/lib/claude_context.mjs" "$CONFIG_DIR/lib/claude_context.mjs" || fail "installed Claude context helper differs"
cmp -s "$REPO_ROOT/opencode/lib/claude_checkpoint.mjs" "$CONFIG_DIR/lib/claude_checkpoint.mjs" || fail "installed Claude checkpoint helper differs"
cmp -s "$REPO_ROOT/opencode/lib/session_metadata.mjs" "$CONFIG_DIR/lib/session_metadata.mjs" || fail "installed session metadata helper differs"
cmp -s "$REPO_ROOT/opencode/lib/opencode_transport.mjs" "$CONFIG_DIR/lib/opencode_transport.mjs" || fail "installed OpenCode transport helper differs"
cmp -s "$REPO_ROOT/opencode/lib/claude_agent.mjs" "$CONFIG_DIR/lib/claude_agent.mjs" || fail "installed Claude helper differs"
cmp -s "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" "$CONFIG_DIR/providers/claude_agent_provider.mjs" || fail "installed Claude provider differs"
jq -e --arg provider "file://$CONFIG_DIR/providers/claude_agent_provider.mjs" --arg claude "$CLAUDE_PATH" '
  .provider["claude-agent"].npm == $provider
  and .provider["claude-agent"].options.claudePath == $claude
  and .provider["claude-agent"].models["claude-opus-4-8"].limit == {"context":200000,"output":32000}
  and .default_agent == "router-auto"
  and .agent["router-auto"].mode == "primary"
  and .agent["router-manual"].mode == "primary"
  and .agent.claude.model == "claude-agent/claude-opus-4-8"
' "$CONFIG_DIR/opencode.jsonc" >/dev/null || fail "installed Claude provider config is invalid"
for legacy in \
  "$CONFIG_DIR/tools/llm_route.ts" \
  "$CONFIG_DIR/tools/claude_agent.ts" \
  "$CONFIG_DIR/tools/stage_prepare.ts" \
  "$CONFIG_DIR/tools/stage_verify.ts" \
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" \
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" \
  "$CONFIG_DIR/lib/prompt_guard.mjs" \
  "$CONFIG_DIR/lib/stage_tools.mjs"; do
  [[ ! -e "$legacy" ]] || fail "legacy file was not retired: $legacy"
done

jq -e '.dependencies["user-package"] == "7.0.0"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user dependency"
jq -e '.scripts.keep == "true"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user script"
jq -e '.dependencies["@opencode-ai/plugin"] == "1.18.4"' "$CONFIG_DIR/package.json" >/dev/null || fail "plugin dependency was not pinned"
jq -e '.dependencies["@opencode-ai/sdk"] == "1.18.4"' "$CONFIG_DIR/package.json" >/dev/null || fail "OpenCode SDK dependency was not pinned"
jq -e '.dependencies["@anthropic-ai/claude-agent-sdk"] == null' "$CONFIG_DIR/package.json" >/dev/null || fail "retired Claude package dependency was preserved"

BACKUP_CONFIG=$(find "$BACKUP_ROOT" -type f -name opencode.jsonc -print)
BACKUP_ROUTE=$(find "$BACKUP_ROOT" -type f -name llm_route.ts -print)
[[ -n "$BACKUP_CONFIG" ]] || fail "changed config was not backed up"
[[ -n "$BACKUP_ROUTE" ]] || fail "retired route tool was not backed up"
[[ "$(stat -f '%Lp' "$BACKUP_ROOT")" == "700" ]] || fail "backup root permissions are not 0700"
[[ "$(stat -f '%Lp' "$BACKUP_CONFIG")" == "600" ]] || fail "backup file permissions are not 0600"
BACKUP_COUNT_BEFORE=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')

SECOND_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH")
BACKUP_COUNT_AFTER=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
[[ "$BACKUP_COUNT_BEFORE" == "$BACKUP_COUNT_AFTER" ]] || fail "idempotent install created another backup"
[[ "$SECOND_OUTPUT" == *"unchanged $CONFIG_DIR/opencode.jsonc"* ]] || fail "idempotent install did not report unchanged config"
[[ "$FIRST_OUTPUT" == *"backup $BACKUP_ROOT/"* ]] || fail "first install did not report its backup"

ATOMIC_CONFIG="$FIXTURE/atomic-config"
mkdir -p "$ATOMIC_CONFIG/plugins"
printf '%s\n' '{"sentinel":"config"}' | tee "$ATOMIC_CONFIG/opencode.jsonc" >/dev/null
printf '%s\n' '{"sentinel":"package"}' | tee "$ATOMIC_CONFIG/package.json" >/dev/null
printf '%s\n' 'symlink target' | tee "$FIXTURE/late-target" >/dev/null
ln -s "$FIXTURE/late-target" "$ATOMIC_CONFIG/plugins/llm_router_handoff.ts"
ATOMIC_BEFORE=$(shasum -a 256 "$ATOMIC_CONFIG/opencode.jsonc" "$ATOMIC_CONFIG/package.json")
if bash "$INSTALLER" --config-dir "$ATOMIC_CONFIG" --backup-root "$FIXTURE/atomic-backups" --router-path "$REPO_ROOT/route" --claude-path "$CLAUDE_PATH" >/dev/null 2>&1; then
  fail "installer accepted a symlink target"
fi
ATOMIC_AFTER=$(shasum -a 256 "$ATOMIC_CONFIG/opencode.jsonc" "$ATOMIC_CONFIG/package.json")
[[ "$ATOMIC_BEFORE" == "$ATOMIC_AFTER" ]] || fail "preflight failure partially changed the active bundle"
[[ ! -e "$FIXTURE/atomic-backups" ]] || fail "preflight failure created backups"

RELATIVE_ROUTE="$FIXTURE/relative-route"
RELATIVE_CLAUDE="$FIXTURE/relative-claude"
cp "$REPO_ROOT/route" "$RELATIVE_ROUTE"
cp "$CLAUDE_PATH" "$RELATIVE_CLAUDE"
chmod +x "$RELATIVE_ROUTE"
chmod +x "$RELATIVE_CLAUDE"
(
  cd "$FIXTURE"
  bash "$INSTALLER" --config-dir relative-config --backup-root relative-backups --router-path relative-route --claude-path relative-claude >/dev/null
)
RELATIVE_ROOT=$(cd "$FIXTURE" && pwd)
assert_contains "$FIXTURE/relative-config/plugins/llm_router_handoff.ts" "const ROUTER_PATH = \"$RELATIVE_ROOT/relative-route\""
assert_contains "$FIXTURE/relative-config/opencode.jsonc" "file://$RELATIVE_ROOT/relative-config/providers/claude_agent_provider.mjs"
assert_contains "$FIXTURE/relative-config/opencode.jsonc" "$RELATIVE_ROOT/relative-claude"

SPECIAL_ROOT="$FIXTURE/special path 'single' \"double\" \\backslash"
SPECIAL_CONFIG="$SPECIAL_ROOT/config path 'quoted' \"double\" \\backslash"
SPECIAL_BACKUPS="$SPECIAL_ROOT/backup path"
SPECIAL_ROUTE="$SPECIAL_ROOT/route 'quoted' \"double\" \\backslash"
SPECIAL_CLAUDE="$SPECIAL_ROOT/claude 'quoted' \"double\" \\backslash"
mkdir -p "$SPECIAL_ROOT"
cp "$REPO_ROOT/route" "$SPECIAL_ROUTE"
chmod +x "$SPECIAL_ROUTE"
write_compatible_claude "$SPECIAL_CLAUDE"

bash "$INSTALLER" \
  --config-dir "$SPECIAL_CONFIG" \
  --backup-root "$SPECIAL_BACKUPS" \
  --router-path "$SPECIAL_ROUTE" \
  --claude-path "$SPECIAL_CLAUDE" >/dev/null

jq empty "$SPECIAL_CONFIG/opencode.jsonc" \
  || fail "special-path opencode.jsonc is invalid"
"$NODE_PATH" --input-type=module --check - \
  < "$SPECIAL_CONFIG/plugins/llm_router_handoff.ts" \
  || fail "special-path handoff plugin is invalid"
"$NODE_PATH" --input-type=module - \
  "$SPECIAL_CONFIG/plugins/llm_router_handoff.ts" "$SPECIAL_ROUTE" <<'NODE'
import { readFileSync } from "node:fs"

const source = readFileSync(process.argv[2], "utf8")
const match = source.match(/^const ROUTER_PATH = (.+)$/m)
if (!match) throw new Error("rendered ROUTER_PATH literal was not found")
const actual = JSON.parse(match[1])
if (actual !== process.argv[3]) {
  throw new Error(`rendered ROUTER_PATH mismatch: ${JSON.stringify(actual)}`)
}
NODE
SPECIAL_PROVIDER_URL=$("$NODE_PATH" -e '
  const { pathToFileURL } = require("node:url")
  process.stdout.write(pathToFileURL(process.argv[1]).href)
' "$SPECIAL_CONFIG/providers/claude_agent_provider.mjs")
jq -e --arg provider "$SPECIAL_PROVIDER_URL" --arg claude "$SPECIAL_CLAUDE" '
  .provider["claude-agent"].npm == $provider
  and .provider["claude-agent"].options.claudePath == $claude
' "$SPECIAL_CONFIG/opencode.jsonc" >/dev/null \
  || fail "special paths were not preserved in opencode.jsonc"

printf 'PASS: dual-router fixed-composer handoff, tool-free Claude CLI, safe install, retirement and idempotence\n'
