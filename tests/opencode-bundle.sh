#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INSTALLER="$REPO_ROOT/opencode/install.sh"
POLICY="$REPO_ROOT/opencode/lib/routing_policy.mjs"
CONTRACT="$REPO_ROOT/opencode/lib/route_contract.mjs"
ROUTE_MANIFEST="$REPO_ROOT/opencode/lib/route_manifest.mjs"
CHECKPOINT="$REPO_ROOT/opencode/lib/claude_checkpoint.mjs"
SESSION_METADATA="$REPO_ROOT/opencode/lib/session_metadata.mjs"
ADAPTIVE_ROUTING="$REPO_ROOT/opencode/lib/adaptive_routing.mjs"
EXECUTION_POLICY="$REPO_ROOT/opencode/lib/execution_policy.mjs"
ROUTER_CONTROL="$REPO_ROOT/opencode/lib/router_control.mjs"
VERIFICATION_CONFIG="$REPO_ROOT/config.json"
NODE_PATH=$(command -v node || true)
[[ -n "$NODE_PATH" ]] || { printf 'FAIL: node is required\n' >&2; exit 1; }

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-opencode-test.XXXXXX")
FIXTURE=$(cd "$FIXTURE" && pwd -P)
preserve_fixture() {
  [[ ! -d "$FIXTURE" ]] \
    || mv "$FIXTURE" "$FIXTURE.preserved" >/dev/null 2>&1 \
    || true
}
trap preserve_fixture EXIT

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

file_mode() {
  local target=$1
  if stat -c '%a' "$target" >/dev/null 2>&1; then
    stat -c '%a' "$target"
  else
    stat -f '%Lp' "$target"
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
    'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then' \
    '  printf "%s\n" "{\"loggedIn\": true, \"authMethod\": \"claude.ai\"}"' \
    '  exit 0' \
    'fi' \
    'exit 0' | tee "$target" >/dev/null
  chmod +x "$target"
}

write_signed_out_claude() {
  local target=$1
  write_compatible_claude "$target"
  printf '%s\n' \
    '#!/bin/sh' \
    'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then' \
    '  printf "%s\n" "{\"loggedIn\": false, \"authMethod\": \"none\"}"' \
    '  exit 1' \
    'fi' \
    "exec \"$target.help\" \"\$@\"" | tee "$target.signed-out" >/dev/null
  cp "$target" "$target.help"
  mv "$target.signed-out" "$target"
  chmod +x "$target" "$target.help"
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
    'if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then' \
    '  printf "%s\n" "{\"loggedIn\": true, \"authMethod\": \"claude.ai\"}"' \
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
  and .default_agent == "router"
  and .agent.router.mode == "primary"
  and .agent.router.model == .model
  and .agent.router.permission == {"*":"deny"}
  and .agent["router-auto"].mode == "subagent"
  and .agent["router-auto"].hidden == true
  and .agent["router-auto"].model == .model
  and .agent["router-auto"].permission == {"*":"deny"}
  and .agent["router-manual"].mode == "subagent"
  and .agent["router-manual"].hidden == true
  and .agent["router-manual"].model == .model
  and .agent["router-manual"].permission == {"*":"deny"}
  and .agent["router-adaptive"].mode == "subagent"
  and .agent["router-adaptive"].hidden == true
  and .agent["router-control"].hidden == true
  and .agent.minimax.mode == "subagent"
  and .agent.glm.mode == "subagent"
  and .agent.claude.mode == "subagent"
  and .agent.codex.mode == "subagent"
  and .agent.claude.model == "claude-agent/claude-opus-5"
  and (.agent.minimax | has("permission") | not)
  and (.agent.glm | has("permission") | not)
  and (.agent.claude | has("permission") | not)
  and (.agent.codex | has("permission") | not)
  and .provider["claude-agent"].npm == "__CLAUDE_AGENT_PROVIDER_URL__"
  and .provider["claude-agent"].name == "Claude Agent SDK"
  and .provider["claude-agent"].options.claudePath == "__CLAUDE_CODE_PATH__"
  and .provider["claude-agent"].options.effort == "xhigh"
  and .provider["claude-agent"].models["claude-opus-5"].limit == {"context":1000000,"output":64000}
  and .provider["claude-agent"].models["claude-opus-5"].attachment == true
  and .provider["claude-agent"].models["claude-opus-5"].modalities == {"input":["image","pdf","text"],"output":["text"]}
  and .provider["router-control"].npm == "__ROUTER_CONTROL_PROVIDER_URL__"
  and (.command | keys | sort) == ["router-adaptive", "router-auto", "router-full", "router-native", "router-pinned", "router-restricted", "router-status", "router-uninstall"]
  and ([.command[] | .subtask] | all(. == false))
  and .agent.codex.model == "openai/gpt-5.6-sol"
  and (.agent | keys | sort) == ["claude", "codex", "glm", "minimax", "router", "router-adaptive", "router-auto", "router-control", "router-manual"]
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
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'announcer.changed(input.sessionID, state)'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'createDirectModelHandoff({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'createOpenCodeV2ClientFromLegacyTransport({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'client: v2Client,'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'v2Client.v2.session.context('
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'client.session.messages({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'projectLegacyClaudeContext(response)'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'CHECKPOINT_TIMEOUT_MS = 30_000'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'unwrapOpenCodeV2Context(response)'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"--summarize", "--json"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'updateSessionMetadata({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'createRouterControlRuntime({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'loadExecutionPolicy({'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"command.execute.before"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" '"tool.execute.before"'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'output.options.cwd = directory'
if grep -E 'persistDirectModelSelection|switchModel' \
  "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" >/dev/null; then
  fail "handoff plugin still persists the composer selection"
fi
assert_contains "$REPO_ROOT/opencode/lib/opencode_transport.mjs" 'const transport = legacyClient?._client'
assert_contains "$REPO_ROOT/opencode/lib/opencode_transport.mjs" 'fetch: config.fetch'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'UNSUPPORTED_MEDIA_TYPE_ERROR_CODE'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'not supported'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'attachmentMediaTypes: mediaTypes'
assert_contains "$REPO_ROOT/opencode/lib/route_manifest.mjs" 'acceptedMediaTypes'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'output.message.agent = selection.target.agent'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'output.message.model = {'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'MANUAL_TARGET_METADATA_KEY'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" 'updateSessionMetadata({'
assert_contains "$REPO_ROOT/opencode/lib/direct_handoff.mjs" '{ sessionID, agent: "router-manual" }'
assert_contains "$REPO_ROOT/opencode/plugins/llm_router_handoff.ts" 'message: STARTUP_NOTICE_MESSAGE'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message?.type === "user"'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message?.type !== "assistant"'
assert_contains "$REPO_ROOT/opencode/lib/claude_context.mjs" 'message.error !== undefined'
[[ -f "$CHECKPOINT" ]] || fail "safe Claude checkpoint module is missing"
[[ -f "$SESSION_METADATA" ]] || fail "serialized session metadata module is missing"
[[ -f "$ADAPTIVE_ROUTING" ]] || fail "adaptive routing module is missing"
[[ -f "$EXECUTION_POLICY" ]] || fail "execution policy module is missing"
[[ -f "$ROUTER_CONTROL" ]] || fail "router control module is missing"
assert_contains "$SESSION_METADATA" 'updatesBySession'
assert_contains "$CHECKPOINT" 'CLAUDE_CHECKPOINT_METADATA_KEY'
assert_contains "$CHECKPOINT" 'createClaudeCheckpointLifecycle'
assert_contains "$CHECKPOINT" 'response?.data?.data'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'specificationVersion: "v3"'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'CLAUDE_MAX_INPUT_BYTES = 32 * 1024 * 1024'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'maxOutputBytes'
assert_contains "$REPO_ROOT/opencode/providers/claude_agent_provider.mjs" 'from "@anthropic-ai/claude-agent-sdk"'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'pathToClaudeCodeExecutable: claudePath'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'permissionMode: profile.mode'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'preset: "claude_code"'
assert_contains "$REPO_ROOT/opencode/lib/claude_agent.mjs" 'persistSession: false'
assert_contains "$REPO_ROOT/opencode/tools/repo_query.ts" 'runRepositoryQuery(args, context.worktree)'
assert_not_contains "$REPO_ROOT/README.md" 'somente a última mensagem do usuário'
assert_not_contains "$REPO_ROOT/README.md" 'como um teto conservador de bytes UTF-8'
assert_not_contains "$REPO_ROOT/README.md" 'Instala as dependências pinadas'
jq -e '.dependencies == {"@anthropic-ai/claude-agent-sdk":"0.3.218","@opencode-ai/plugin":"1.18.4","@opencode-ai/sdk":"1.18.4","jsonc-parser":"3.3.1"}' "$REPO_ROOT/opencode/package.json" >/dev/null || fail "bundle dependencies are not pinned"
jq -e '
  .verification.rules[]
  | select(.name == "llm-router-opencode-tests")
  | . as $rule
  | .gates[]
  | select(.type == "command" and .argv[0:2] == ["node", "--test"])
  | ($rule.match.changed_any | index("tests/route-manifest.test.mjs")) != null
    and ($rule.match.changed_any | index("tests/startup-notice.test.mjs")) != null
    and (.argv | index("tests/router-handoff.test.mjs")) != null
    and (.argv | index("tests/claude-agent.test.mjs")) != null
    and (.argv | index("tests/claude-agent-provider.test.mjs")) != null
    and (.argv | index("tests/execution-policy.test.mjs")) != null
    and (.argv | index("tests/router-control.test.mjs")) != null
    and (.argv | index("tests/route-manifest.test.mjs")) != null
    and (.argv | index("tests/repo-query.test.mjs")) != null
    and (.argv | index("tests/startup-notice.test.mjs")) != null
    and (.argv | index("tests/uninstall.test.mjs")) != null
    and (.untrusted_if_changed | index("tests/route-manifest.test.mjs")) != null
    and (.untrusted_if_changed | index("tests/startup-notice.test.mjs")) != null
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

"$NODE_PATH" --input-type=module - \
  "$POLICY" \
  "$CONTRACT" \
  "$ROUTE_MANIFEST" \
  "$REPO_ROOT/route" <<'NODE'
import { execFileSync } from "node:child_process"
import { pathToFileURL } from "node:url"

const policy = await import(pathToFileURL(process.argv[2]))
const contract = await import(pathToFileURL(process.argv[3]))
const routeManifest = await import(pathToFileURL(process.argv[4]))
const manifest = routeManifest.parseRouteManifest(execFileSync(
  process.argv[5],
  ["--manifest", "--json"],
  { encoding: "utf8" },
))
if (manifest.schema_version !== 2) {
  throw new Error("route --manifest did not generate schema version 2")
}
for (const routing of manifest.routing) {
  if (typeof routing.route !== "string" || !routing.route) {
    throw new Error(`manifest intent ${routing.intent} does not define a route`)
  }
}

const routeCases = [
  ["minimax", "crie router-proof.txt com conteúdo exato", "glm"],
  ["minimax", "quantos arquivos existem no projeto?", "minimax"],
  ["minimax", "conte os arquivos. Não altere arquivos.", "minimax"],
  ["minimax", "traduza esta mensagem para português", "glm"],
  ["claude", "planeje uma arquitetura", "claude"],
  ["claude", "corrija uma condição de corrida", "claude"],
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
  modelID: "claude-opus-5",
})) throw new Error("Claude target is not the local Agent SDK provider")

const parsed = contract.parseClassifierResult(JSON.stringify({
  schema_version: 1,
  intent: "literal_read_only_no_writing",
  route: "minimax",
}), manifest)
if (parsed.route !== "minimax") throw new Error("valid classifier result was not parsed")
if (contract.assertClassifierRequestSize("small request") !== 13) {
  throw new Error("classifier request size was not measured in UTF-8 bytes")
}
let oversizedRequestRejected = false
try {
  contract.assertClassifierRequestSize("x".repeat(contract.MAX_CLASSIFIER_REQUEST_BYTES + 1))
} catch (error) {
  oversizedRequestRejected = /exceeds/.test(String(error))
}
if (!oversizedRequestRejected) throw new Error("oversized classifier request was accepted")

for (const invalid of [
  "not-json",
  JSON.stringify({
    schema_version: 2,
    intent: "literal_read_only_no_writing",
    route: "minimax",
  }),
  JSON.stringify({
    schema_version: 1,
    intent: "literal_read_only_no_writing",
    route: "minimax",
    difficulty: "simple",
  }),
  JSON.stringify({
    schema_version: 1,
    intent: "literal_read_only_no_writing",
    route: "missing",
  }),
  JSON.stringify({
    schema_version: 1,
    intent: "literal_read_only_no_writing",
    route: "minimax",
    extra: true,
  }),
]) {
  let rejected = false
  try {
    contract.parseClassifierResult(invalid, manifest)
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
# script(1) fails with "tcgetattr/ioctl" when its stdin is not a terminal, which
# is what CI runners and agent shells hand to the installer.
: > "$FIXTURE/empty-stdin"
bash "$INSTALLER" \
  --dry-run \
  --config-dir "$FIXTURE/tty-help-detached-config" \
  --backup-root "$FIXTURE/tty-help-detached-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$TTY_ONLY_CLAUDE" >/dev/null <"$FIXTURE/empty-stdin" \
  || fail "installer rejected TTY-only Claude flags when stdin is not a terminal"

# A profile without a session makes Claude Code answer every handoff with an
# expired-login error, so the installer says so instead of failing later.
SIGNED_OUT_CLAUDE="$FIXTURE/signed-out-claude"
write_signed_out_claude "$SIGNED_OUT_CLAUDE"
SIGNED_OUT_WARNING=$(bash "$INSTALLER" \
  --dry-run \
  --config-dir "$FIXTURE/signed-out-config" \
  --backup-root "$FIXTURE/signed-out-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$SIGNED_OUT_CLAUDE" 2>&1 >/dev/null) \
  || fail "installer failed instead of warning about a signed-out Claude profile"
grep -F 'claude auth login' <<< "$SIGNED_OUT_WARNING" >/dev/null \
  || fail "installer did not report the signed-out Claude profile"
# A route pointing at a provider neither the bundle nor OpenCode knows would
# install cleanly and only fail when the user reached that route.
UNKNOWN_PROVIDER_ROUTER="$FIXTURE/unknown-provider-route"
printf '%s\n' \
  '#!/bin/sh' \
  'if [ "${1:-}" = "--manifest" ]; then' \
  '  cat "$LLM_ROUTER_TEST_MANIFEST"' \
  '  exit 0' \
  'fi' \
  'exit 0' | tee "$UNKNOWN_PROVIDER_ROUTER" >/dev/null
chmod +x "$UNKNOWN_PROVIDER_ROUTER"
"$REPO_ROOT/route" --manifest --json \
  | jq '.routes[0].target.providerID = "provider-that-does-not-exist"' \
  > "$FIXTURE/unknown-provider-manifest.json"
if command -v opencode >/dev/null 2>&1; then
  UNKNOWN_PROVIDER_ERROR=$(LLM_ROUTER_TEST_MANIFEST="$FIXTURE/unknown-provider-manifest.json" \
    bash "$INSTALLER" \
    --dry-run \
    --config-dir "$FIXTURE/unknown-provider-config" \
    --backup-root "$FIXTURE/unknown-provider-backups" \
    --router-path "$UNKNOWN_PROVIDER_ROUTER" \
    --claude-path "$CLAUDE_PATH" 2>&1 >/dev/null) \
    && fail "installer accepted a route provider OpenCode does not know"
  grep -F 'provider-that-does-not-exist' <<< "$UNKNOWN_PROVIDER_ERROR" >/dev/null \
    || fail "installer did not name the unknown route provider"
fi

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

UNSUPPORTED_MANIFEST="$FIXTURE/unsupported-manifest.json"
"$REPO_ROOT/route" --manifest --json \
  | jq '.schema_version = 3' \
  | tee "$UNSUPPORTED_MANIFEST" >/dev/null
UNSUPPORTED_MANIFEST_ROUTE="$FIXTURE/unsupported-manifest-route"
printf '%s\n' \
  '#!/bin/sh' \
  'cat "$(dirname "$0")/unsupported-manifest.json"' \
  | tee "$UNSUPPORTED_MANIFEST_ROUTE" >/dev/null
chmod +x "$UNSUPPORTED_MANIFEST_ROUTE"
if UNSUPPORTED_MANIFEST_OUTPUT=$(bash "$INSTALLER" \
  --dry-run \
  --config-dir "$FIXTURE/unsupported-manifest-config" \
  --backup-root "$FIXTURE/unsupported-manifest-backups" \
  --router-path "$UNSUPPORTED_MANIFEST_ROUTE" \
  --claude-path "$CLAUDE_PATH" 2>&1); then
  fail "installer accepted a route executable with an unsupported manifest version"
fi
[[ "$UNSUPPORTED_MANIFEST_OUTPUT" == *"route manifest must use schema_version 2"* ]] \
  || fail "unsupported manifest did not report the version guard"
[[ ! -e "$FIXTURE/unsupported-manifest-config" ]] \
  || fail "unsupported manifest created the target config"

mkdir -p "$CONFIG_DIR/tools" "$CONFIG_DIR/plugins" "$CONFIG_DIR/lib" "$CONFIG_DIR/providers"
printf '%s\n' '{"previous":true}' | tee "$CONFIG_DIR/opencode.jsonc" >/dev/null
printf '%s\n' '{"private":true,"dependencies":{"user-package":"7.0.0","@anthropic-ai/claude-agent-sdk":"0.3.100","@opencode-ai/plugin":"0.1.0","@opencode-ai/sdk":"0.1.0"},"scripts":{"keep":"true"}}' | tee "$CONFIG_DIR/package.json" >/dev/null
printf '%s\n' 'stale helper' | tee "$CONFIG_DIR/lib/claude_agent.mjs" >/dev/null
printf '%s\n' 'requireRouterRequest parseClassifierResult' \
  | tee "$CONFIG_DIR/tools/llm_route.ts" >/dev/null
printf '%s\n' 'runClaudeAgentQuery claude-agent-sdk' \
  | tee "$CONFIG_DIR/tools/claude_agent.ts" >/dev/null
printf '%s\n' 'prepareStagePayload runStageVerifier' \
  | tee "$CONFIG_DIR/tools/stage_prepare.ts" >/dev/null
printf '%s\n' 'verifyStagePayload runStageVerifier' \
  | tee "$CONFIG_DIR/tools/stage_verify.ts" >/dev/null
printf '%s\n' \
  'import { createRouterPromptGuard } from "../lib/prompt_guard.mjs"' \
  '' \
  'export default async function llmRouterPromptGuard() {' \
  '  return createRouterPromptGuard()' \
  '}' \
  | tee "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" >/dev/null
printf '%s\n' 'createRouterPromptGuard prompt_guard' \
  | tee "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" >/dev/null
printf '%s\n' 'llm-router.prompt-guard.store.v1 createRouterPromptGuard' \
  | tee "$CONFIG_DIR/lib/prompt_guard.mjs" >/dev/null
printf '%s\n' 'prepareStagePayload runStageVerifier' \
  | tee "$CONFIG_DIR/lib/stage_tools.mjs" >/dev/null
printf '%s\n' 'const OPENCODE_PATH = "/custom/opencode"' \
  'const description = "Run a delegated stage"' \
  'custom user tool' \
  | tee "$CONFIG_DIR/tools/delegate_task.ts" >/dev/null
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
[[ -e "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" ]] || fail "dry-run retired prompt guard"
[[ ! -e "$BACKUP_ROOT" ]] || fail "dry-run created a backup directory"
[[ "$DRY_RUN_OUTPUT" == *"would retire $CONFIG_DIR/plugins/llm_router_prompt_guard.ts (with backup)"* ]] || fail "dry-run did not report prompt guard retirement"

FIRST_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH")

assert_contains "$CONFIG_DIR/plugins/llm_router_handoff.ts" "const ROUTER_PATH = \"$REPO_ROOT/route\""
assert_contains "$CONFIG_DIR/tools/delegate_task.ts" 'custom user tool'
# Named comparisons only cover the files someone remembered to list. This one
# covers every copied helper, so a new library that the installer forgets, or a
# source paired with the wrong target, fails here.
for source in "$REPO_ROOT"/opencode/lib/*.mjs "$REPO_ROOT"/opencode/providers/*.mjs; do
  installed="$CONFIG_DIR/${source#"$REPO_ROOT"/opencode/}"
  [[ -e "$installed" ]] || fail "installer did not copy $(basename "$source")"
  cmp -s "$source" "$installed" || fail "installed file differs from its source: $(basename "$source")"
done

cmp -s "$REPO_ROOT/opencode/llm-router.policy.defaults.json" "$CONFIG_DIR/llm-router.policy.defaults.json" || fail "installed policy defaults differ"
cmp -s "$REPO_ROOT/opencode/llm-router.policy.schema.json" "$CONFIG_DIR/llm-router.policy.schema.json" || fail "installed policy schema differs"
cmp -s "$REPO_ROOT/opencode/llm-router.policy.defaults.json" "$CONFIG_DIR/llm-router.policy.json" || fail "initial user policy differs from defaults"
jq -e --arg provider "file://$CONFIG_DIR/providers/claude_agent_provider.mjs" --arg control "file://$CONFIG_DIR/providers/router_control_provider.mjs" --arg claude "$CLAUDE_PATH" --arg claude_config_dir "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" '
  .provider["claude-agent"].npm == $provider
  and .provider["router-control"].npm == $control
  and .provider["claude-agent"].options.claudePath == $claude
  and .provider["claude-agent"].options.claudeConfigDir == $claude_config_dir
  and .provider["claude-agent"].options.effort == "xhigh"
  and .provider["claude-agent"].models["claude-opus-5"].limit == {"context":1000000,"output":64000}
  and .previous == true
  and .default_agent == "router"
  and .agent.router.mode == "primary"
  and .agent["router-auto"].mode == "subagent"
  and .agent["router-manual"].mode == "subagent"
  and .agent.claude.model == "claude-agent/claude-opus-5"
  and (.command | keys | sort) == ["router-adaptive", "router-auto", "router-full", "router-native", "router-pinned", "router-restricted", "router-status", "router-uninstall"]
  and ([.command[] | .subtask] | all(. == false))
' "$CONFIG_DIR/opencode.jsonc" >/dev/null || fail "installed Claude provider config is invalid"
[[ ! -e "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts" ]] \
  || fail "known legacy prompt guard was not retired"
for preserved in \
  "$CONFIG_DIR/tools/llm_route.ts" \
  "$CONFIG_DIR/tools/claude_agent.ts" \
  "$CONFIG_DIR/tools/stage_prepare.ts" \
  "$CONFIG_DIR/tools/stage_verify.ts" \
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.js" \
  "$CONFIG_DIR/lib/prompt_guard.mjs" \
  "$CONFIG_DIR/lib/stage_tools.mjs" \
  "$CONFIG_DIR/tools/delegate_task.ts"; do
  [[ -e "$preserved" ]] || fail "unrecognized legacy-path file was retired: $preserved"
done

jq -e '.dependencies["user-package"] == "7.0.0"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user dependency"
jq -e '.scripts.keep == "true"' "$CONFIG_DIR/package.json" >/dev/null || fail "package merge removed user script"
jq -e '.dependencies["@opencode-ai/plugin"] == "1.18.4"' "$CONFIG_DIR/package.json" >/dev/null || fail "plugin dependency was not pinned"
jq -e '.dependencies["@opencode-ai/sdk"] == "1.18.4"' "$CONFIG_DIR/package.json" >/dev/null || fail "OpenCode SDK dependency was not pinned"
jq -e '.dependencies["@anthropic-ai/claude-agent-sdk"] == "0.3.218"' "$CONFIG_DIR/package.json" >/dev/null || fail "Claude Agent SDK dependency was not pinned"
jq -e '.dependencies["jsonc-parser"] == "3.3.1"' "$CONFIG_DIR/package.json" >/dev/null || fail "JSONC parser dependency was not pinned"

INSTALL_STATE="$CONFIG_DIR/llm-router.install-state.json"
[[ -f "$INSTALL_STATE" && ! -L "$INSTALL_STATE" ]] || fail "install state was not created as a regular file"
[[ "$(file_mode "$CONFIG_DIR")" == "700" ]] || fail "config directory permissions are not 0700"
[[ "$(file_mode "$CONFIG_DIR/.llm-router-backups")" == "700" ]] || fail "persistent backup root permissions are not 0700"
[[ "$(file_mode "$INSTALL_STATE")" == "600" ]] || fail "install state permissions are not 0600"
jq -e --arg config "$CONFIG_DIR" '
  .schemaVersion == 1
  and .status == "installed"
  and .legacy == false
  and .configDir == $config
  and (.baselineDir | startswith(".llm-router-backups/install/"))
  and .sharedBaselines.opencode.existed == true
  and .sharedBaselines.opencode.backupPath == "shared/opencode.jsonc"
  and .sharedBaselines.package.existed == true
  and .sharedBaselines.package.backupPath == "shared/package.json"
  and any(
    .managedConfig[];
    .path == ["agent", "router"] and .installedValue.mode == "primary"
  )
  and any(
    .managedDependencies[];
    .name == "jsonc-parser" and .installedValue == "3.3.1"
  )
  and any(
    .managedFiles[];
    .relativePath == "lib/claude_agent.mjs"
      and .ownership == "replaced"
      and .original.known == true
      and .original.existed == true
      and .original.backupPath == "managed/lib/claude_agent.mjs"
  )
  and any(
    .managedFiles[];
    .relativePath == "lib/install_state.mjs"
      and .ownership == "created"
      and (.installedSha256 | length) == 64
  )
' "$INSTALL_STATE" >/dev/null || fail "install state schema or ownership records are invalid"
STATE_BASELINE=$(jq -r '.baselineDir' "$INSTALL_STATE")
[[ -f "$CONFIG_DIR/$STATE_BASELINE/$(jq -r '.sharedBaselines.opencode.backupPath' "$INSTALL_STATE")" ]] \
  || fail "persistent OpenCode config baseline is missing"
[[ -f "$CONFIG_DIR/$STATE_BASELINE/$(jq -r '.managedFiles[] | select(.relativePath == "lib/claude_agent.mjs") | .original.backupPath' "$INSTALL_STATE")" ]] \
  || fail "persistent managed-file baseline is missing"
[[ "$(file_mode "$CONFIG_DIR/$STATE_BASELINE")" == "700" ]] \
  || fail "persistent install baseline permissions are not 0700"

printf '%s\n' '{"schemaVersion":1,"defaultProfile":"full"}' | tee "$CONFIG_DIR/llm-router.policy.json" >/dev/null

BACKUP_CONFIG=$(find "$BACKUP_ROOT" -type f -name opencode.jsonc -print)
BACKUP_ROUTE=$(find "$BACKUP_ROOT" -type f -name llm_router_prompt_guard.ts -print)
[[ -n "$BACKUP_CONFIG" ]] || fail "changed config was not backed up"
[[ -n "$BACKUP_ROUTE" ]] || fail "retired prompt guard was not backed up"
[[ "$(file_mode "$BACKUP_ROOT")" == "700" ]] || fail "backup root permissions are not 0700"
[[ "$(file_mode "$BACKUP_CONFIG")" == "600" ]] || fail "backup file permissions are not 0600"
BACKUP_COUNT_BEFORE=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
STATE_BASELINE_BEFORE=$(jq -r '.baselineDir' "$INSTALL_STATE")

SECOND_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH")
BACKUP_COUNT_AFTER=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
[[ "$BACKUP_COUNT_BEFORE" == "$BACKUP_COUNT_AFTER" ]] || fail "idempotent install created another backup"
[[ "$(jq -r '.baselineDir' "$INSTALL_STATE")" == "$STATE_BASELINE_BEFORE" ]] \
  || fail "idempotent install replaced the persistent baseline"
[[ "$SECOND_OUTPUT" == *"unchanged $CONFIG_DIR/opencode.jsonc"* ]] || fail "idempotent install did not report unchanged config"
assert_contains "$CONFIG_DIR/llm-router.policy.json" '"defaultProfile":"full"'
[[ "$SECOND_OUTPUT" == *"preserved $CONFIG_DIR/llm-router.policy.json"* ]] || fail "idempotent install did not preserve user policy"
[[ "$FIRST_OUTPUT" == *"backup $BACKUP_ROOT/"* ]] || fail "first install did not report its backup"

REINSTALL_CONFIG="$FIXTURE/reinstall-config"
bash "$INSTALLER" \
  --config-dir "$REINSTALL_CONFIG" \
  --backup-root "$FIXTURE/reinstall-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
printf '%s\n' '{"schemaVersion":1,"defaultProfile":"restricted","userMarker":"keep"}' \
  | tee "$REINSTALL_CONFIG/llm-router.policy.json" >/dev/null
ln -s "$REPO_ROOT/opencode/node_modules" "$REINSTALL_CONFIG/node_modules"
UNINSTALL_OUTPUT=$("$NODE_PATH" --input-type=module - "$REINSTALL_CONFIG" <<'NODE'
import path from "node:path"
import { pathToFileURL } from "node:url"

const configDir = process.argv[2]
const moduleUrl = pathToFileURL(path.join(configDir, "lib/uninstall.mjs")).href
const { createOpenCodeUninstaller } = await import(moduleUrl)
const uninstaller = await createOpenCodeUninstaller({
  configDir,
  tokenFactory: () => "bundle-reinstall-confirmation",
})
const preview = await uninstaller.execute("")
if (!preview.includes("/router-uninstall bundle-reinstall-confirmation")) {
  throw new Error("uninstall preview did not return its confirmation token")
}
process.stdout.write(await uninstaller.execute("bundle-reinstall-confirmation"))
NODE
)
[[ "$UNINSTALL_OUTPUT" == *"without calling an LLM"* ]] \
  || fail "installed uninstaller did not complete locally"
[[ ! -e "$REINSTALL_CONFIG/llm-router.install-state.json" ]] \
  || fail "uninstall left the active installation state behind"
assert_contains "$REINSTALL_CONFIG/llm-router.policy.json" '"userMarker":"keep"'
[[ ! -e "$REINSTALL_CONFIG/opencode.jsonc" ]] \
  || fail "uninstall left fresh router control configuration active"
bash "$INSTALLER" \
  --config-dir "$REINSTALL_CONFIG" \
  --backup-root "$FIXTURE/reinstall-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
jq -e '
  .schemaVersion == 1
  and .status == "installed"
' "$REINSTALL_CONFIG/llm-router.install-state.json" >/dev/null \
  || fail "reinstall did not recreate an installed state"
jq -e '
  .provider["router-control"] != null
  and .command["router-uninstall"] != null
' "$REINSTALL_CONFIG/opencode.jsonc" >/dev/null \
  || fail "reinstall did not restore router control configuration"
assert_contains "$REINSTALL_CONFIG/llm-router.policy.json" '"userMarker":"keep"'

LEGACY_CONFIG="$FIXTURE/legacy-config"
mkdir -p "$LEGACY_CONFIG/plugins"
cp "$CONFIG_DIR/opencode.jsonc" "$LEGACY_CONFIG/opencode.jsonc"
cp "$CONFIG_DIR/package.json" "$LEGACY_CONFIG/package.json"
cp "$CONFIG_DIR/plugins/llm_router_handoff.ts" "$LEGACY_CONFIG/plugins/llm_router_handoff.ts"
bash "$INSTALLER" \
  --config-dir "$LEGACY_CONFIG" \
  --backup-root "$FIXTURE/legacy-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
jq -e '
  .schemaVersion == 1
  and .status == "installed"
  and .legacy == true
  and any(
    .managedConfig[];
    .path == ["agent", "router"]
      and .original.known == false
      and .original.existed == false
  )
  and any(
    .managedFiles[];
    .relativePath == "plugins/llm_router_handoff.ts"
      and .ownership == "legacy"
      and .original.known == false
  )
' "$LEGACY_CONFIG/llm-router.install-state.json" >/dev/null \
  || fail "legacy installation without state was not recorded conservatively"

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
cp "$REPO_ROOT/config.json" "$FIXTURE/config.json"
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
assert_contains "$FIXTURE/relative-config/opencode.jsonc" "file://$RELATIVE_ROOT/relative-config/providers/router_control_provider.mjs"
assert_contains "$FIXTURE/relative-config/opencode.jsonc" "$RELATIVE_ROOT/relative-claude"

COMPAT_ROUTE_ROOT="$FIXTURE/compatible-manifest-router"
mkdir -p "$COMPAT_ROUTE_ROOT"
cp "$REPO_ROOT/route" "$COMPAT_ROUTE_ROOT/route"
chmod +x "$COMPAT_ROUTE_ROOT/route"
for COMPAT_SCHEMA in 1 2; do
  jq --argjson schema "$COMPAT_SCHEMA" '
    .schema_version = $schema
  ' "$REPO_ROOT/config.json" | tee "$COMPAT_ROUTE_ROOT/config.json" >/dev/null
  COMPAT_MANIFEST=$("$COMPAT_ROUTE_ROOT/route" --manifest --json)
  jq -e '
    .schema_version == 2
    and (.routing | length > 0)
    and all(.routing[]; .route | type == "string" and length > 0)
  ' <<<"$COMPAT_MANIFEST" >/dev/null \
    || fail "schema v$COMPAT_SCHEMA config did not normalize to a schema v2 manifest"
  bash "$INSTALLER" \
    --config-dir "$FIXTURE/schema-v$COMPAT_SCHEMA-config" \
    --backup-root "$FIXTURE/schema-v$COMPAT_SCHEMA-backups" \
    --router-path "$COMPAT_ROUTE_ROOT/route" \
    --claude-path "$CLAUDE_PATH" >/dev/null
  jq -e '
    .agent.minimax.model == "minimax-coding-plan/MiniMax-M3"
    and .agent.glm.model == "zai-coding-plan/glm-5.2"
    and .agent.claude.model == "claude-agent/claude-opus-5"
    and .agent.codex.model == "openai/gpt-5.6-sol"
  ' "$FIXTURE/schema-v$COMPAT_SCHEMA-config/opencode.jsonc" >/dev/null \
    || fail "schema v$COMPAT_SCHEMA compatibility did not generate the legacy agents"
done

CUSTOM_ROUTE_ROOT="$FIXTURE/custom-router"
CUSTOM_CONFIG_DIR="$FIXTURE/custom-route-config"
mkdir -p "$CUSTOM_ROUTE_ROOT"
cp "$REPO_ROOT/route" "$CUSTOM_ROUTE_ROOT/route"
chmod +x "$CUSTOM_ROUTE_ROOT/route"
jq '
  .routes += [{
    id: "custom",
    display_name: "Custom Worker",
    order: 4,
    target: {
      agent: "custom-worker",
      providerID: "openai",
      modelID: "gpt-5.6-mini"
    },
    capabilities: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true
    },
    acceptedMediaTypes: ["image/*", "text/plain"]
  }, {
    id: "custom-claude",
    display_name: "Custom Claude",
    order: 5,
    target: {
      agent: "custom-claude",
      providerID: "claude-agent",
      modelID: "claude-custom"
    },
    capabilities: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true
    },
    acceptedMediaTypes: ["application/pdf", "image/png"]
  }]
  | .routing += [{
      intent: "custom_work",
      route: "custom",
      help: "custom work",
      description: "custom work"
    }, {
      intent: "custom_claude_work",
      route: "custom-claude",
      help: "custom Claude work",
      description: "custom Claude work"
    }]
' "$REPO_ROOT/config.json" | tee "$CUSTOM_ROUTE_ROOT/config.json" >/dev/null
bash "$INSTALLER" \
  --config-dir "$CUSTOM_CONFIG_DIR" \
  --backup-root "$FIXTURE/custom-route-backups" \
  --router-path "$CUSTOM_ROUTE_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
jq -e '
  .agent["custom-worker"].model == "openai/gpt-5.6-mini"
  and .agent["custom-worker"].mode == "subagent"
  and .agent["custom-claude"].model == "claude-agent/claude-custom"
  and .agent["custom-claude"].mode == "subagent"
  and .provider["claude-agent"].models["claude-custom"].name == "Custom Claude"
  and .provider["claude-agent"].models["claude-custom"].attachment == true
  and .provider["claude-agent"].models["claude-custom"].modalities
    == {"input":["image","pdf","text"],"output":["text"]}
  and .provider["zai-coding-plan"].models["glm-5.2"].attachment == false
  and .provider["zai-coding-plan"].models["glm-5.2"].modalities
    == {"input":["text"],"output":["text"]}
' "$CUSTOM_CONFIG_DIR/opencode.jsonc" >/dev/null \
  || fail "manifest routes did not generate their OpenCode agents and models"

jq '
  .agent["custom-claude"].description = "user-customized worker"
' "$CUSTOM_CONFIG_DIR/opencode.jsonc" \
  | tee "$CUSTOM_CONFIG_DIR/opencode.updated.jsonc" >/dev/null
mv "$CUSTOM_CONFIG_DIR/opencode.updated.jsonc" "$CUSTOM_CONFIG_DIR/opencode.jsonc"
cp "$REPO_ROOT/config.json" "$CUSTOM_ROUTE_ROOT/config.json"
bash "$INSTALLER" \
  --config-dir "$CUSTOM_CONFIG_DIR" \
  --backup-root "$FIXTURE/custom-route-backups" \
  --router-path "$CUSTOM_ROUTE_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
jq -e '
  (.agent | has("custom-worker") | not)
  and .agent["custom-claude"].description == "user-customized worker"
' "$CUSTOM_CONFIG_DIR/opencode.jsonc" >/dev/null \
  || fail "route removal did not clean unchanged agents and preserve user-modified agents"
jq -e '
  all(
    .managedConfig[];
    .path != ["agent", "custom-worker"]
      and .path != ["agent", "custom-claude"]
  )
' "$CUSTOM_CONFIG_DIR/llm-router.install-state.json" >/dev/null \
  || fail "route removal left retired agents in the installation state"

CANONICAL_ROOT="$FIXTURE/canonical-root"
ALIASED_ROOT="$FIXTURE/aliased-root"
mkdir -p "$CANONICAL_ROOT"
ln -s "$CANONICAL_ROOT" "$ALIASED_ROOT"
ALIASED_CONFIG="$ALIASED_ROOT/config"
CANONICAL_CONFIG="$CANONICAL_ROOT/config"
bash "$INSTALLER" \
  --config-dir "$ALIASED_CONFIG" \
  --backup-root "$FIXTURE/aliased-backups" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$CLAUDE_PATH" >/dev/null
jq -e --arg config "$CANONICAL_CONFIG" '
  .schemaVersion == 1
  and .status == "installed"
  and .configDir == $config
' "$CANONICAL_CONFIG/llm-router.install-state.json" >/dev/null \
  || fail "install state did not persist the canonical config directory"
assert_contains "$CANONICAL_CONFIG/opencode.jsonc" "file://$CANONICAL_CONFIG/providers/claude_agent_provider.mjs"
assert_contains "$CANONICAL_CONFIG/opencode.jsonc" "file://$CANONICAL_CONFIG/providers/router_control_provider.mjs"

SPECIAL_ROOT="$FIXTURE/special path 'single' \"double\" \\backslash"
SPECIAL_CONFIG="$SPECIAL_ROOT/config path 'quoted' \"double\" \\backslash"
SPECIAL_BACKUPS="$SPECIAL_ROOT/backup path"
SPECIAL_ROUTE="$SPECIAL_ROOT/route 'quoted' \"double\" \\backslash"
SPECIAL_CLAUDE="$SPECIAL_ROOT/claude 'quoted' \"double\" \\backslash"
mkdir -p "$SPECIAL_ROOT"
cp "$REPO_ROOT/route" "$SPECIAL_ROUTE"
cp "$REPO_ROOT/config.json" "$SPECIAL_ROOT/config.json"
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
SPECIAL_CONTROL_PROVIDER_URL=$("$NODE_PATH" -e '
  const { pathToFileURL } = require("node:url")
  process.stdout.write(pathToFileURL(process.argv[1]).href)
' "$SPECIAL_CONFIG/providers/router_control_provider.mjs")
jq -e --arg provider "$SPECIAL_PROVIDER_URL" --arg control "$SPECIAL_CONTROL_PROVIDER_URL" --arg claude "$SPECIAL_CLAUDE" '
  .provider["claude-agent"].npm == $provider
  and .provider["router-control"].npm == $control
  and .provider["claude-agent"].options.claudePath == $claude
' "$SPECIAL_CONFIG/opencode.jsonc" >/dev/null \
  || fail "special paths were not preserved in opencode.jsonc"

printf 'PASS: single router, adaptive policies, Claude Agent SDK tools, safe install and preserved user policy\n'
