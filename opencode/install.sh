#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DRY_RUN=false
CONFIG_DIR=""
BACKUP_ROOT="/tmp/claude-backups"
ROUTER_PATH=""
CLAUDE_PATH=""
RENDER_DIR=""
PENDING_TARGET=""
BACKUP_DIR=""

show_help() {
  cat <<'HELP'
Install the versioned llm-router integration into OpenCode.

Usage:
  opencode/install.sh [options]

Options:
  --dry-run               Show changes without touching the target config.
  --config-dir PATH       OpenCode config directory. Defaults to the XDG or user config path.
  --backup-root PATH      Backup root. Defaults to /tmp/claude-backups.
  --router-path PATH      llm-router executable. Defaults to this repository's route script.
  --claude-path PATH      Claude Code executable. Defaults to claude from PATH.
  -h, --help              Show this help.

Existing changed files are copied to a timestamped backup before replacement.
An identical installation is left untouched and creates no backup.
Existing package.json dependencies are preserved while required versions are merged.
HELP
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a path"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --config-dir)
      require_value "$@"
      CONFIG_DIR=$2
      shift 2
      ;;
    --backup-root)
      require_value "$@"
      BACKUP_ROOT=$2
      shift 2
      ;;
    --router-path)
      require_value "$@"
      ROUTER_PATH=$2
      shift 2
      ;;
    --claude-path)
      require_value "$@"
      CLAUDE_PATH=$2
      shift 2
      ;;
    -h|--help)
      show_help
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

if [[ -z "$CONFIG_DIR" ]]; then
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
  else
    CONFIG_DIR="${HOME:?HOME is required}/.config/opencode"
  fi
fi

[[ -n "$ROUTER_PATH" ]] || ROUTER_PATH="$REPO_ROOT/route"
[[ -n "$CLAUDE_PATH" ]] || CLAUDE_PATH=$(command -v claude || true)
JQ_PATH=$(command -v jq || true)
NODE_PATH=$(command -v node || true)
CONFIG_MERGER="$REPO_ROOT/scripts/merge-opencode-config.mjs"
[[ -n "$JQ_PATH" ]] || fail "jq is required to merge package.json"
[[ -n "$NODE_PATH" ]] || fail "node is required to render and validate the bundle"
[[ -f "$CONFIG_MERGER" ]] || fail "OpenCode config merger is missing: $CONFIG_MERGER"
if ! (cd "$REPO_ROOT" && "$NODE_PATH" -e 'import("jsonc-parser")') >/dev/null 2>&1; then
  fail "repository dependencies are missing; run pnpm install --frozen-lockfile"
fi

case "$CONFIG_DIR" in /*) ;; *) CONFIG_DIR="$PWD/$CONFIG_DIR" ;; esac
case "$BACKUP_ROOT" in /*) ;; *) BACKUP_ROOT="$PWD/$BACKUP_ROOT" ;; esac
CONFIG_DIR=$("$NODE_PATH" -e '
  const { existsSync, realpathSync } = require("node:fs")
  const { basename, dirname, resolve } = require("node:path")
  let current = resolve(process.argv[1])
  const suffix = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`cannot resolve config directory: ${process.argv[1]}`)
    suffix.unshift(basename(current))
    current = parent
  }
  process.stdout.write(resolve(realpathSync.native(current), ...suffix))
' "$CONFIG_DIR") || fail "cannot resolve config directory: $CONFIG_DIR"
ROUTER_PATH="$(cd "$(dirname "$ROUTER_PATH")" && pwd)/$(basename "$ROUTER_PATH")"
[[ -x "$ROUTER_PATH" ]] || fail "llm-router executable not found: $ROUTER_PATH"
[[ -n "$CLAUDE_PATH" ]] || fail "Claude Code executable not found in PATH"
CLAUDE_PATH="$(cd "$(dirname "$CLAUDE_PATH")" && pwd)/$(basename "$CLAUDE_PATH")"
[[ -x "$CLAUDE_PATH" ]] || fail "Claude Code executable not found: $CLAUDE_PATH"

CLAUDE_REQUIRED_FLAGS=(
  --print
  --input-format
  --output-format
  --verbose
  --include-partial-messages
  --model
  --permission-mode
  --safe-mode
  --tools
  --strict-mcp-config
  --mcp-config
  --disable-slash-commands
  --no-chrome
  --no-session-persistence
  --system-prompt
)

claude_help_has_required_flags() {
  local help_text=$1
  local required_flag
  for required_flag in "${CLAUDE_REQUIRED_FLAGS[@]}"; do
    if ! grep -E \
      "^[[:space:]]+([^[:space:]]+,[[:space:]]+)?${required_flag}([[:space:]]|$)" \
      <<< "$help_text" >/dev/null; then
      return 1
    fi
  done
}

capture_claude_help_in_tty() {
  local script_path
  local command
  script_path=$(command -v script || true)
  [[ -n "$script_path" ]] || return 1

  # script(1) reads the terminal attributes of its own stdin. An installer
  # started from a pipe or socket makes that call fail, so stdin is detached.
  if "$script_path" --version 2>/dev/null | grep -qi 'util-linux'; then
    printf -v command '%q --help' "$CLAUDE_PATH"
    "$script_path" -q -e -c "$command" /dev/null </dev/null 2>&1
  else
    "$script_path" -q /dev/null "$CLAUDE_PATH" --help </dev/null 2>&1
  fi
}

CLAUDE_HELP=$("$CLAUDE_PATH" --help 2>&1) || fail "Claude Code --help failed: $CLAUDE_PATH"
if ! claude_help_has_required_flags "$CLAUDE_HELP"; then
  if TTY_CLAUDE_HELP=$(capture_claude_help_in_tty) \
    && claude_help_has_required_flags "$TTY_CLAUDE_HELP"; then
    CLAUDE_HELP=$TTY_CLAUDE_HELP
  fi
fi
for required_flag in "${CLAUDE_REQUIRED_FLAGS[@]}"; do
  if ! grep -E \
    "^[[:space:]]+([^[:space:]]+,[[:space:]]+)?${required_flag}([[:space:]]|$)" \
    <<< "$CLAUDE_HELP" >/dev/null; then
    fail "Claude Code does not support required flag: $required_flag"
  fi
done

# OpenCode starts from a desktop app that does not inherit the shell exports, so
# the Claude profile is resolved here and pinned in the configuration. Without
# it, Claude Code reads a profile with no session and reports the login as
# expired on every handoff.
CLAUDE_CONFIG_DIR_VALUE=${CLAUDE_CONFIG_DIR:-${HOME:?HOME is required}/.claude}
case "$CLAUDE_CONFIG_DIR_VALUE" in
  /*) ;;
  *) fail "CLAUDE_CONFIG_DIR must be an absolute path: $CLAUDE_CONFIG_DIR_VALUE" ;;
esac
CLAUDE_AUTH_STATUS=$(CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR_VALUE" "$CLAUDE_PATH" auth status 2>/dev/null || true)
if ! grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true' <<< "$CLAUDE_AUTH_STATUS"; then
  printf 'warning: Claude Code is not signed in for %s. Run: CLAUDE_CONFIG_DIR=%s claude auth login\n' \
    "$CLAUDE_CONFIG_DIR_VALUE" "$CLAUDE_CONFIG_DIR_VALUE" >&2
fi

preserve_runtime_files() {
  if [[ -n "$PENDING_TARGET" && -e "$PENDING_TARGET" ]]; then
    mv "$PENDING_TARGET" \
      "$RENDER_DIR/$(basename "$PENDING_TARGET").incomplete" \
      >/dev/null 2>&1 || true
  fi
  if [[ -n "$RENDER_DIR" && -d "$RENDER_DIR" ]]; then
    mv "$RENDER_DIR" "$RENDER_DIR.preserved" >/dev/null 2>&1 || true
  fi
}
trap preserve_runtime_files EXIT

RENDER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-opencode.XXXXXX")
mkdir -p "$RENDER_DIR/tools" "$RENDER_DIR/lib" "$RENDER_DIR/plugins" "$RENDER_DIR/providers"
"$ROUTER_PATH" --manifest --json | tee "$RENDER_DIR/route-manifest.json" >/dev/null \
  || fail "cannot load the validated route manifest"
if ! "$NODE_PATH" --input-type=module - \
  "$SCRIPT_DIR/lib/route_manifest.mjs" \
  "$RENDER_DIR/route-manifest.json" <<'NODE'
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const manifestModule = await import(pathToFileURL(process.argv[2]))
const raw = readFileSync(process.argv[3], "utf8")
const value = JSON.parse(raw)
if (value.schema_version !== manifestModule.ROUTE_MANIFEST_SCHEMA_VERSION) {
  throw new Error(
    `route manifest must use schema_version ${manifestModule.ROUTE_MANIFEST_SCHEMA_VERSION}`,
  )
}
manifestModule.parseRouteManifest(raw)
NODE
then
  fail "route manifest output is invalid"
fi
cp "$SCRIPT_DIR/package.json" "$RENDER_DIR/package.required.json"
cp "$SCRIPT_DIR/lib/claude_agent.mjs" "$RENDER_DIR/lib/claude_agent.mjs"
cp "$SCRIPT_DIR/lib/claude_context.mjs" "$RENDER_DIR/lib/claude_context.mjs"
cp "$SCRIPT_DIR/lib/claude_checkpoint.mjs" "$RENDER_DIR/lib/claude_checkpoint.mjs"
cp "$SCRIPT_DIR/lib/adaptive_routing.mjs" "$RENDER_DIR/lib/adaptive_routing.mjs"
cp "$SCRIPT_DIR/lib/direct_handoff.mjs" "$RENDER_DIR/lib/direct_handoff.mjs"
cp "$SCRIPT_DIR/lib/execution_policy.mjs" "$RENDER_DIR/lib/execution_policy.mjs"
cp "$SCRIPT_DIR/lib/install_state.mjs" "$RENDER_DIR/lib/install_state.mjs"
cp "$SCRIPT_DIR/lib/uninstall.mjs" "$RENDER_DIR/lib/uninstall.mjs"
cp "$SCRIPT_DIR/lib/opencode_transport.mjs" "$RENDER_DIR/lib/opencode_transport.mjs"
cp "$SCRIPT_DIR/lib/repo_query.mjs" "$RENDER_DIR/lib/repo_query.mjs"
cp "$SCRIPT_DIR/lib/router_control.mjs" "$RENDER_DIR/lib/router_control.mjs"
cp "$SCRIPT_DIR/lib/router_feedback.mjs" "$RENDER_DIR/lib/router_feedback.mjs"
cp "$SCRIPT_DIR/lib/route_contract.mjs" "$RENDER_DIR/lib/route_contract.mjs"
cp "$SCRIPT_DIR/lib/route_manifest.mjs" "$RENDER_DIR/lib/route_manifest.mjs"
cp "$SCRIPT_DIR/lib/routing_policy.mjs" "$RENDER_DIR/lib/routing_policy.mjs"
cp "$SCRIPT_DIR/lib/session_metadata.mjs" "$RENDER_DIR/lib/session_metadata.mjs"
cp "$SCRIPT_DIR/lib/startup_notice.mjs" "$RENDER_DIR/lib/startup_notice.mjs"
cp "$SCRIPT_DIR/tools/repo_query.ts" "$RENDER_DIR/tools/repo_query.ts"
cp "$SCRIPT_DIR/plugins/llm_router_handoff.ts" "$RENDER_DIR/plugins/llm_router_handoff.ts"
cp "$SCRIPT_DIR/providers/claude_agent_provider.mjs" "$RENDER_DIR/providers/claude_agent_provider.mjs"
cp "$SCRIPT_DIR/providers/router_control_provider.mjs" "$RENDER_DIR/providers/router_control_provider.mjs"
cp "$SCRIPT_DIR/llm-router.policy.defaults.json" "$RENDER_DIR/llm-router.policy.defaults.json"
cp "$SCRIPT_DIR/llm-router.policy.schema.json" "$RENDER_DIR/llm-router.policy.schema.json"

PROVIDER_URL=$("$NODE_PATH" -e '
  const { pathToFileURL } = require("node:url")
  process.stdout.write(pathToFileURL(process.argv[1]).href)
' "$CONFIG_DIR/providers/claude_agent_provider.mjs")
CONTROL_PROVIDER_URL=$("$NODE_PATH" -e '
  const { pathToFileURL } = require("node:url")
  process.stdout.write(pathToFileURL(process.argv[1]).href)
' "$CONFIG_DIR/providers/router_control_provider.mjs")

ROUTER_PATH_VALUE="$ROUTER_PATH" "$NODE_PATH" -e '
  const { readFileSync } = require("node:fs")
  const template = readFileSync(process.argv[1], "utf8")
  const token = "__LLM_ROUTER_PATH_LITERAL__"
  const fragments = template.split(token)
  if (fragments.length !== 2) throw new Error(`expected exactly one ${token} token`)
  process.stdout.write(fragments.join(JSON.stringify(process.env.ROUTER_PATH_VALUE)))
' "$SCRIPT_DIR/plugins/llm_router_handoff.ts" \
  | tee "$RENDER_DIR/plugins/llm_router_handoff.ts" >/dev/null

"$JQ_PATH" \
  --arg provider_url "$PROVIDER_URL" \
  --arg control_provider_url "$CONTROL_PROVIDER_URL" \
  --arg claude_path "$CLAUDE_PATH" \
  --arg claude_config_dir "$CLAUDE_CONFIG_DIR_VALUE" \
  --slurpfile manifest "$RENDER_DIR/route-manifest.json" '
  .agent as $agent_templates
  | .agent = (
      .agent
      | with_entries(select(.key | startswith("router")))
    )
  | .provider["claude-agent"].npm = $provider_url
  | .provider["claude-agent"].options.claudePath = $claude_path
  | .provider["claude-agent"].options.claudeConfigDir = $claude_config_dir
  | .provider["router-control"].npm = $control_provider_url
  | reduce $manifest[0].routes[] as $route (.;
      ($route.target.providerID) as $provider_id
      | ($route.target.modelID) as $model_id
      | ($route.display_name // $route.id) as $display_name
      | .agent[$route.target.agent] = (
          ($agent_templates[$route.target.agent] // {
            description: "\($display_name) worker managed by llm-router.",
            mode: "subagent",
            steps: 32,
            prompt: "Handle the user request directly. Inspect relevant sources, keep changes scoped, validate the result, and do not route again."
          })
          + {model: "\($provider_id)/\($model_id)"}
        )
      | if (.provider[$provider_id].models? | type) == "object" then
          .provider[$provider_id].models[$model_id] = (
            (.provider[$provider_id].models[$model_id] // {name: $display_name})
            + {
                attachment: (($route.acceptedMediaTypes // []) | length > 0),
                modalities: {
                  input: (
                    ["text"] + [
                      ($route.acceptedMediaTypes // [])[]
                      | if startswith("image/") then "image"
                        elif . == "application/pdf" then "pdf"
                        elif startswith("audio/") then "audio"
                        elif startswith("video/") then "video"
                        else empty
                        end
                    ] | unique
                  ),
                  output: ["text"]
                }
              }
          )
        elif (.provider[$provider_id].whitelist? | type) == "array" then
          .provider[$provider_id].whitelist |= (
            if index($model_id) == null then . + [$model_id] else . end
          )
        else
          # A provider the bundle does not declare may still be one OpenCode
          # resolves on its own, so the route is kept and reported below.
          .
        end
    )
' "$SCRIPT_DIR/opencode.jsonc" | tee "$RENDER_DIR/opencode.required.json" >/dev/null

"$JQ_PATH" empty "$RENDER_DIR/opencode.required.json" >/dev/null 2>&1 \
  || fail "rendered required OpenCode configuration is invalid"

# A route may target a provider the bundle does not declare, because OpenCode
# resolves some on its own. Asking OpenCode separates that case from a typo in
# the manifest, which would otherwise install cleanly and only fail when the
# user reaches that route.
UNDECLARED_PROVIDERS=$("$JQ_PATH" -r \
  --slurpfile manifest "$RENDER_DIR/route-manifest.json" '
  (.provider // {} | keys) as $declared
  | [$manifest[0].routes[].target.providerID]
  | unique
  | map(select(. as $id | $declared | index($id) | not))
  | join(" ")
' "$RENDER_DIR/opencode.required.json")
if [[ -n "$UNDECLARED_PROVIDERS" ]]; then
  OPENCODE_PATH=$(command -v opencode || true)
  for provider_id in $UNDECLARED_PROVIDERS; do
    if [[ -z "$OPENCODE_PATH" ]]; then
      printf 'warning: route provider %s is not declared by the bundle and OpenCode is not on PATH to confirm it exists\n' \
        "$provider_id" >&2
      continue
    fi
    # The output is captured first because pipefail would hide the match
    # behind the exit status of a failing lookup.
    provider_lookup=$("$OPENCODE_PATH" models "$provider_id" 2>&1 || true)
    if grep -qi 'provider not found' <<< "$provider_lookup"; then
      fail "route provider is unknown to OpenCode: $provider_id"
    fi
  done
fi
if [[ -e "$CONFIG_DIR/opencode.jsonc" ]]; then
  [[ ! -L "$CONFIG_DIR/opencode.jsonc" ]] \
    || fail "refusing to replace symlink: $CONFIG_DIR/opencode.jsonc"
  [[ -f "$CONFIG_DIR/opencode.jsonc" ]] \
    || fail "refusing to replace non-file: $CONFIG_DIR/opencode.jsonc"
  CONFIG_MERGER_ARGS=(
    --current "$CONFIG_DIR/opencode.jsonc"
    --required "$RENDER_DIR/opencode.required.json"
    --output "$RENDER_DIR/opencode.jsonc"
  )
  if [[ -e "$CONFIG_DIR/llm-router.install-state.json" ]]; then
    [[ -f "$CONFIG_DIR/llm-router.install-state.json" \
      && ! -L "$CONFIG_DIR/llm-router.install-state.json" ]] \
      || fail "refusing to read invalid installation state: $CONFIG_DIR/llm-router.install-state.json"
    CONFIG_MERGER_ARGS+=(--state "$CONFIG_DIR/llm-router.install-state.json")
  fi
  "$NODE_PATH" "$CONFIG_MERGER" "${CONFIG_MERGER_ARGS[@]}" \
    || fail "cannot merge the existing OpenCode configuration"
else
  cp "$RENDER_DIR/opencode.required.json" "$RENDER_DIR/opencode.jsonc"
fi
"$NODE_PATH" --check "$RENDER_DIR/plugins/llm_router_handoff.ts" >/dev/null 2>&1 \
  || fail "rendered llm_router_handoff.ts is invalid"

PACKAGE_TARGET="$CONFIG_DIR/package.json"
[[ ! -L "$PACKAGE_TARGET" ]] || fail "refusing to replace symlink: $PACKAGE_TARGET"
if [[ -e "$PACKAGE_TARGET" ]]; then
  "$JQ_PATH" empty "$PACKAGE_TARGET" >/dev/null 2>&1 || fail "invalid package.json: $PACKAGE_TARGET"
  "$JQ_PATH" -S --slurpfile required "$RENDER_DIR/package.required.json" '
    . as $current
    | $current + {
        private: ($current.private // $required[0].private // true),
        dependencies: (($current.dependencies // {}) + ($required[0].dependencies // {}))
      }
  ' "$PACKAGE_TARGET" | tee "$RENDER_DIR/package.json" >/dev/null
else
  cp "$RENDER_DIR/package.required.json" "$RENDER_DIR/package.json"
fi
"$JQ_PATH" empty "$RENDER_DIR/package.json" >/dev/null 2>&1 || fail "rendered package.json is invalid"

if grep -R -E '__[A-Z0-9_]+__' "$RENDER_DIR" >/dev/null; then
  fail "unresolved installation placeholder in rendered bundle"
fi

ensure_backup_dir() {
  local candidate
  [[ -n "$BACKUP_DIR" ]] && return
  [[ ! -L "$BACKUP_ROOT" ]] || fail "refusing to use symlink backup root: $BACKUP_ROOT"
  (umask 077 && mkdir -p "$BACKUP_ROOT")
  [[ -d "$BACKUP_ROOT" && -O "$BACKUP_ROOT" ]] || fail "backup root must be an owned directory: $BACKUP_ROOT"
  chmod 700 "$BACKUP_ROOT"
  while true; do
    candidate="$BACKUP_ROOT/$(date +%Y%m%d_%H%M%S)"
    if (umask 077 && mkdir "$candidate") 2>/dev/null; then
      chmod 700 "$candidate"
      BACKUP_DIR=$candidate
      return
    fi
    sleep 1
  done
}

backup_file() {
  local target=$1
  local relative=${target#"$CONFIG_DIR"/}
  ensure_backup_dir
  (umask 077 && mkdir -p "$BACKUP_DIR/$(dirname "$relative")")
  chmod 700 "$BACKUP_DIR/$(dirname "$relative")"
  cp -p "$target" "$BACKUP_DIR/$relative"
  chmod 600 "$BACKUP_DIR/$relative"
}

preflight_target() {
  local target=$1
  local action=$2
  local parent

  [[ ! -L "$target" ]] || fail "refusing to $action symlink: $target"
  [[ ! -e "$target" || -f "$target" ]] || fail "refusing to $action non-file: $target"
  if [[ -e "$target" ]]; then
    [[ -w "$target" ]] || fail "target is not writable: $target"
    return
  fi
  parent=$(dirname "$target")
  while [[ ! -e "$parent" ]]; do
    [[ "$parent" != "/" ]] || break
    parent=$(dirname "$parent")
  done
  [[ -d "$parent" && -w "$parent" ]] || fail "target parent is not writable: $target"
}

sync_file() {
  local source=$1
  local target=$2
  local action

  [[ ! -L "$target" ]] || fail "refusing to replace symlink: $target"
  if [[ ! -e "$target" ]]; then
    action=install
  elif cmp -s "$source" "$target"; then
    printf 'unchanged %s\n' "$target"
    return
  else
    action=update
  fi

  if [[ "$DRY_RUN" == true ]]; then
    if [[ "$action" == update ]]; then
      printf 'would update %s (with backup)\n' "$target"
    else
      printf 'would install %s\n' "$target"
    fi
    return
  fi

  mkdir -p "$(dirname "$target")"
  PENDING_TARGET="$target.llm-router.$$"
  cp "$source" "$PENDING_TARGET"
  mv -f "$PENDING_TARGET" "$target"
  PENDING_TARGET=""
  printf '%s %s\n' "$action" "$target"
}

install_once_file() {
  local source=$1
  local target=$2
  if [[ -e "$target" ]]; then
    printf 'preserved %s\n' "$target"
    return
  fi
  sync_file "$source" "$target"
}

retire_file() {
  local target=$1
  local relative
  local retained
  [[ -e "$target" ]] || return 0
  if ! is_known_retired_file "$target"; then
    printf 'preserved unrecognized legacy path %s\n' "$target"
    return
  fi
  [[ ! -L "$target" ]] || fail "refusing to retire symlink: $target"

  if [[ "$DRY_RUN" == true ]]; then
    printf 'would retire %s (with backup)\n' "$target"
    return
  fi

  [[ -n "$BACKUP_DIR" ]] || fail "backup directory missing while retiring $target"
  relative=${target#"$CONFIG_DIR"/}
  retained="$BACKUP_DIR/retired/$relative"
  (umask 077 && mkdir -p "$(dirname "$retained")")
  mv "$target" "$retained"
  chmod 600 "$retained"
  printf 'retired %s\n' "$target"
}

is_known_retired_file() {
  local target=$1
  local relative=${target#"$CONFIG_DIR"/}
  local actual_hash
  local expected_hashes
  [[ -f "$target" && ! -L "$target" ]] || return 1
  actual_hash=$("$NODE_PATH" --input-type=module - "$target" <<'NODE'
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

const source = readFileSync(process.argv[2], "utf8")
const normalized = source.replace(
  /^const (ROUTER_PATH|UV_PATH|STAGE_VERIFIER_PATH|CONFIG_PATH|LOG_PATH|CLAUDE_PATH|OPENCODE_PATH) = .*$/gmu,
  'const $1 = "__NORMALIZED_PATH__"',
)
process.stdout.write(createHash("sha256").update(normalized).digest("hex"))
NODE
)
  case "$relative" in
    lib/prompt_guard.mjs)
      expected_hashes="d72b196e6ac1d38114ce17df34fcd358d8117c679ba95608f4f8f2f703fee82f"
      ;;
    lib/stage_tools.mjs)
      expected_hashes="dc2d75b2d9c6d316f663c807f962945f137a405d15072f23a877a88457b4959e"
      ;;
    tools/llm_route.ts)
      expected_hashes="039094d0526f76e254f92b1e20b6ea1dac79f76aad4efd6021578f2dbee29a0e 2099299b2f9de49b8992bf765a5a65cc32be170a1aaa6f18ae7309c81d7bdad6 57068696d5f880325026129dea19d51529cf1895fb058eb2338de68d12b074e3"
      ;;
    tools/claude_agent.ts)
      expected_hashes="4711a15408957bb86b0265671f79b45fec348a153f30d4b56facca28be1f9ce0"
      ;;
    tools/stage_prepare.ts)
      expected_hashes="37cbce495280328a32bee94dfc518d576d1a4a7c02cb872c6df76c0467c6e632"
      ;;
    tools/stage_verify.ts)
      expected_hashes="bc00325441cfb52a7f4355ee16ef939eb101e59d6bfdcc4e7120839ff276c7aa"
      ;;
    plugins/llm_router_prompt_guard.ts)
      expected_hashes="31a0e5da57efd5572be1b59c2732faf1bb308adf769142866e0ab4f11841a7de"
      ;;
    tools/claude_opus.ts)
      expected_hashes="93ed1b9b5b77147d8f5303fcbddde8d7d770559d4cc263b2d15228da278c3723"
      ;;
    tools/delegate_task.ts)
      expected_hashes="6eea6c83cf13ad33a69987d592540a8273d188d95f660e8eb5e673a9b8d34911"
      ;;
    *)
      return 1
      ;;
  esac
  case " $expected_hashes " in
    *" $actual_hash "*) return 0 ;;
    *) return 1 ;;
  esac
}

SOURCES=(
  "$RENDER_DIR/package.json"
  "$RENDER_DIR/lib/adaptive_routing.mjs"
  "$RENDER_DIR/lib/claude_agent.mjs"
  "$RENDER_DIR/lib/claude_context.mjs"
  "$RENDER_DIR/lib/claude_checkpoint.mjs"
  "$RENDER_DIR/lib/direct_handoff.mjs"
  "$RENDER_DIR/lib/execution_policy.mjs"
  "$RENDER_DIR/lib/install_state.mjs"
  "$RENDER_DIR/lib/uninstall.mjs"
  "$RENDER_DIR/lib/opencode_transport.mjs"
  "$RENDER_DIR/lib/repo_query.mjs"
  "$RENDER_DIR/lib/route_contract.mjs"
  "$RENDER_DIR/lib/route_manifest.mjs"
  "$RENDER_DIR/lib/router_control.mjs"
  "$RENDER_DIR/lib/router_feedback.mjs"
  "$RENDER_DIR/lib/routing_policy.mjs"
  "$RENDER_DIR/lib/session_metadata.mjs"
  "$RENDER_DIR/lib/startup_notice.mjs"
  "$RENDER_DIR/tools/repo_query.ts"
  "$RENDER_DIR/plugins/llm_router_handoff.ts"
  "$RENDER_DIR/providers/claude_agent_provider.mjs"
  "$RENDER_DIR/providers/router_control_provider.mjs"
  "$RENDER_DIR/llm-router.policy.defaults.json"
  "$RENDER_DIR/llm-router.policy.schema.json"
  "$RENDER_DIR/opencode.jsonc"
)
# Every managed file keeps its path inside the configuration directory, so the
# targets are derived instead of listed. A second list would pair a source with
# the wrong target whenever one of them gained an entry.
TARGETS=()
for source in "${SOURCES[@]}"; do
  case "$source" in
    "$RENDER_DIR"/*) TARGETS+=("$CONFIG_DIR/${source#"$RENDER_DIR"/}") ;;
    *) fail "managed source outside the render directory: $source" ;;
  esac
done
RETIRED_TARGETS=(
  "$CONFIG_DIR/lib/prompt_guard.mjs"
  "$CONFIG_DIR/lib/stage_tools.mjs"
  "$CONFIG_DIR/tools/llm_route.ts"
  "$CONFIG_DIR/tools/claude_agent.ts"
  "$CONFIG_DIR/tools/stage_prepare.ts"
  "$CONFIG_DIR/tools/stage_verify.ts"
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts"
  "$CONFIG_DIR/tools/claude_opus.ts"
  "$CONFIG_DIR/tools/delegate_task.ts"
)

for index in "${!TARGETS[@]}"; do
  preflight_target "${TARGETS[$index]}" "replace"
done
preflight_target "$CONFIG_DIR/llm-router.policy.json" "preserve"
for target in "${RETIRED_TARGETS[@]}"; do
  if [[ -e "$target" ]] && is_known_retired_file "$target"; then
    preflight_target "$target" "retire"
  fi
done

INSTALL_STATE_ARGS=(
  --config-dir "$CONFIG_DIR"
  --required-config "$RENDER_DIR/opencode.required.json"
  --required-package "$RENDER_DIR/package.required.json"
)
for index in "${!TARGETS[@]}"; do
  case "${TARGETS[$index]}" in
    "$CONFIG_DIR/opencode.jsonc"|"$CONFIG_DIR/package.json")
      ;;
    *)
      INSTALL_STATE_ARGS+=(
        --managed-file
        "${TARGETS[$index]#"$CONFIG_DIR"/}"
        "${SOURCES[$index]}"
      )
      ;;
  esac
done

if [[ "$DRY_RUN" != true ]]; then
  "$NODE_PATH" "$SCRIPT_DIR/lib/install_state.mjs" prepare "${INSTALL_STATE_ARGS[@]}" \
    || fail "cannot prepare the persistent installation state"
  for index in "${!TARGETS[@]}"; do
    if [[ -e "${TARGETS[$index]}" ]] && ! cmp -s "${SOURCES[$index]}" "${TARGETS[$index]}"; then
      backup_file "${TARGETS[$index]}"
    fi
  done
  for target in "${RETIRED_TARGETS[@]}"; do
    if [[ -e "$target" ]] && is_known_retired_file "$target"; then
      backup_file "$target"
    fi
  done
fi

for index in "${!TARGETS[@]}"; do
  sync_file "${SOURCES[$index]}" "${TARGETS[$index]}"
done
install_once_file "$RENDER_DIR/llm-router.policy.defaults.json" "$CONFIG_DIR/llm-router.policy.json"
for target in "${RETIRED_TARGETS[@]}"; do
  retire_file "$target"
done

if [[ "$DRY_RUN" != true ]]; then
  "$NODE_PATH" "$SCRIPT_DIR/lib/install_state.mjs" finalize "${INSTALL_STATE_ARGS[@]}" \
    || fail "cannot finalize the persistent installation state"
fi

if [[ -n "$BACKUP_DIR" ]]; then
  printf 'backup %s\n' "$BACKUP_DIR"
fi
