#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
INSTALLER="$REPO_ROOT/opencode/install.sh"
POLICY="$REPO_ROOT/opencode/lib/routing_policy.mjs"
TRASH_PATH=$(command -v trash || true)
NOOP_PATH=$(type -P true || true)
NODE_PATH=$(type -P node || true)
[[ -n "$TRASH_PATH" ]] || { printf 'FAIL: trash is required\n' >&2; exit 1; }
[[ -n "$NOOP_PATH" ]] || { printf 'FAIL: true is required\n' >&2; exit 1; }
[[ -n "$NODE_PATH" ]] || { printf 'FAIL: node is required\n' >&2; exit 1; }

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

bash -n "$INSTALLER"
bash -n "$0"

if grep -E '(^|[[:space:]])(rm|rmdir|unlink)([[:space:]]|$)' "$INSTALLER" >/dev/null; then
  fail "installer contains a permanently destructive command"
fi

assert_contains "$REPO_ROOT/opencode/opencode.jsonc" '"disabled_providers": ["github-copilot", "opencode-go"]'
assert_contains "$REPO_ROOT/opencode/opencode.jsonc" '"whitelist": ["MiniMax-M3"]'
assert_contains "$REPO_ROOT/opencode/opencode.jsonc" '"model": "openai/gpt-5.6-sol"'
assert_contains "$REPO_ROOT/opencode/opencode.jsonc" '"reasoningEffort": "xhigh"'
assert_contains "$REPO_ROOT/opencode/opencode.jsonc" '"textVerbosity": "medium"'
assert_contains "$REPO_ROOT/opencode/opencode.jsonc" "Pass the user's original request to llm_route verbatim"
assert_contains "$REPO_ROOT/opencode/tools/claude_opus.ts" 'tool.schema.enum(["xhigh", "max"])'
assert_contains "$REPO_ROOT/opencode/tools/claude_opus.ts" 'args.effort'
assert_contains "$REPO_ROOT/opencode/tools/llm_route.ts" 'Bun.spawn([ROUTER_PATH, args.request]'
if grep -F 'stagePrompt' "$REPO_ROOT/opencode/tools/llm_route.ts" >/dev/null; then
  fail "llm_route rewrites the original request before classification"
fi

# JavaScript template literals must reach Node unchanged.
# shellcheck disable=SC2016
"$NODE_PATH" --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { enforceMinimumRoute, selectClaudeEffort } = await import(pathToFileURL(process.argv[1]));
  const cases = [
    ["minimax", "request", "crie router-proof.txt com conteúdo exato", "glm"],
    ["minimax", "request", "edite src/app.ts e corrija o bug", "glm"],
    ["minimax", "request", "corrija o teste quebrado", "glm"],
    ["minimax", "request", "modifique a configuração", "glm"],
    ["minimax", "request", "apague o arquivo antigo", "glm"],
    ["minimax", "request", "substitua o conteúdo por um patch", "glm"],
    ["minimax", "execute", "router-proof.txt deve conter ok", "glm"],
    ["minimax", "request", "quantos arquivos existem no projeto?", "minimax"],
    ["codex", "plan", "planeje e implemente uma correção complexa", "claude"],
    ["codex", "execute", "implemente a correção de concorrência", "codex"],
    ["claude", "execute", "implemente a arquitetura do produto", "codex"],
    ["claude", "request", "proponha a arquitetura do produto", "claude"],
  ];
  for (const [route, stage, request, expected] of cases) {
    const actual = enforceMinimumRoute(route, stage, request);
    if (actual !== expected) {
      throw new Error(`${request}: expected ${expected}, received ${actual}`);
    }
  }

  const effortCases = [
    ["plan", "Defina a estratégia de migração.", "max"],
    ["request", "Proponha a arquitetura deste produto.", "max"],
    ["request", "Faça ideação de novos produtos.", "max"],
    ["request", "Escreva copy de venda criativa.", "max"],
    ["request", "Abra uma discussão técnica sobre os trade-offs.", "xhigh"],
    ["request", "Debata esta política e tente falsificar o argumento.", "xhigh"],
    ["request", "Responda sem categoria específica.", "max"],
  ];
  for (const [stage, request, expected] of effortCases) {
    const actual = selectClaudeEffort(stage, request);
    if (actual !== expected) {
      throw new Error(`${request}: expected effort ${expected}, received ${actual}`);
    }
  }
' "$POLICY"

CONFIG_DIR="$FIXTURE/config"
BACKUP_ROOT="$FIXTURE/backups"
mkdir -p "$CONFIG_DIR"
printf '%s\n' '{"previous":true}' | tee "$CONFIG_DIR/opencode.jsonc" >/dev/null
BEFORE_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc")

DRY_RUN_OUTPUT=$(bash "$INSTALLER" \
  --dry-run \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$NOOP_PATH" \
  --opencode-path "$NOOP_PATH")

AFTER_DRY_RUN=$(shasum -a 256 "$CONFIG_DIR/opencode.jsonc")
[[ "$BEFORE_DRY_RUN" == "$AFTER_DRY_RUN" ]] || fail "dry-run modified the target config"
[[ ! -e "$BACKUP_ROOT" ]] || fail "dry-run created a backup directory"
[[ "$DRY_RUN_OUTPUT" == *"would update $CONFIG_DIR/opencode.jsonc (with backup)"* ]] || fail "dry-run did not report the config update"

FIRST_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$NOOP_PATH" \
  --opencode-path "$NOOP_PATH")

cmp -s "$REPO_ROOT/opencode/opencode.jsonc" "$CONFIG_DIR/opencode.jsonc" || fail "installed config differs from the versioned template"
assert_contains "$CONFIG_DIR/tools/llm_route.ts" "const ROUTER_PATH = \"$REPO_ROOT/route\""
assert_contains "$CONFIG_DIR/tools/claude_opus.ts" "const CLAUDE_PATH = \"$NOOP_PATH\""
assert_contains "$CONFIG_DIR/tools/delegate_task.ts" "const OPENCODE_PATH = \"$NOOP_PATH\""
cmp -s "$POLICY" "$CONFIG_DIR/lib/routing_policy.mjs" || fail "installed routing policy differs from the versioned policy"

if grep -R -E '__[A-Z0-9_]+__' "$CONFIG_DIR" >/dev/null; then
  fail "installed bundle contains an unresolved placeholder"
fi

BACKUP_CONFIG=$(find "$BACKUP_ROOT" -type f -name opencode.jsonc -print)
[[ -n "$BACKUP_CONFIG" ]] || fail "changed config was not backed up"
assert_contains "$BACKUP_CONFIG" '{"previous":true}'
BACKUP_COUNT_BEFORE=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')

SECOND_OUTPUT=$(bash "$INSTALLER" \
  --config-dir "$CONFIG_DIR" \
  --backup-root "$BACKUP_ROOT" \
  --router-path "$REPO_ROOT/route" \
  --claude-path "$NOOP_PATH" \
  --opencode-path "$NOOP_PATH")

BACKUP_COUNT_AFTER=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -print | wc -l | tr -d ' ')
[[ "$BACKUP_COUNT_BEFORE" == "$BACKUP_COUNT_AFTER" ]] || fail "idempotent install created another backup"
[[ "$SECOND_OUTPUT" == *"unchanged $CONFIG_DIR/opencode.jsonc"* ]] || fail "idempotent install did not report unchanged config"
[[ "$FIRST_OUTPUT" == *"backup $BACKUP_ROOT/"* ]] || fail "first install did not report its backup"

printf 'PASS: OpenCode bundle, verbatim routing, stage policy, mutation guard, dry-run, backup, and idempotence\n'
