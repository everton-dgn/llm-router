#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DRY_RUN=false
CONFIG_DIR=""
BACKUP_ROOT="/tmp/claude-backups"
ROUTER_PATH=""
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
PERL_PATH=$(command -v perl || true)
TRASH_PATH=$(command -v trash || true)
JQ_PATH=$(command -v jq || true)
UV_PATH=$(command -v uv || true)
[[ -n "$PERL_PATH" ]] || fail "perl is required to render executable paths"
[[ -n "$TRASH_PATH" ]] || fail "trash is required for recoverable temporary cleanup"
[[ -n "$JQ_PATH" ]] || fail "jq is required to merge package.json"
[[ -n "$UV_PATH" ]] || fail "uv is required to run deterministic verification"

case "$CONFIG_DIR" in /*) ;; *) CONFIG_DIR="$PWD/$CONFIG_DIR" ;; esac
case "$BACKUP_ROOT" in /*) ;; *) BACKUP_ROOT="$PWD/$BACKUP_ROOT" ;; esac
ROUTER_PATH="$(cd "$(dirname "$ROUTER_PATH")" && pwd)/$(basename "$ROUTER_PATH")"
[[ -x "$ROUTER_PATH" ]] || fail "llm-router executable not found: $ROUTER_PATH"

cleanup() {
  if [[ -n "$PENDING_TARGET" && -e "$PENDING_TARGET" ]]; then
    "$TRASH_PATH" "$PENDING_TARGET" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RENDER_DIR" && -d "$RENDER_DIR" ]]; then
    "$TRASH_PATH" "$RENDER_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

RENDER_DIR=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-opencode.XXXXXX")
mkdir -p "$RENDER_DIR/tools" "$RENDER_DIR/lib" "$RENDER_DIR/plugins"
cp "$SCRIPT_DIR/opencode.jsonc" "$RENDER_DIR/opencode.jsonc"
cp "$SCRIPT_DIR/package.json" "$RENDER_DIR/package.required.json"
cp "$REPO_ROOT/config.json" "$RENDER_DIR/lib/llm-router-config.json"
cp "$REPO_ROOT/stage_verifier.py" "$RENDER_DIR/lib/stage_verifier.py"
cp "$SCRIPT_DIR/tools/llm_route.ts" "$RENDER_DIR/tools/llm_route.ts"
cp "$SCRIPT_DIR/tools/claude_agent.ts" "$RENDER_DIR/tools/claude_agent.ts"
cp "$SCRIPT_DIR/tools/stage_prepare.ts" "$RENDER_DIR/tools/stage_prepare.ts"
cp "$SCRIPT_DIR/tools/stage_verify.ts" "$RENDER_DIR/tools/stage_verify.ts"
cp "$SCRIPT_DIR/lib/claude_agent.mjs" "$RENDER_DIR/lib/claude_agent.mjs"
cp "$SCRIPT_DIR/lib/prompt_guard.mjs" "$RENDER_DIR/lib/prompt_guard.mjs"
cp "$SCRIPT_DIR/lib/repo_query.mjs" "$RENDER_DIR/lib/repo_query.mjs"
cp "$SCRIPT_DIR/lib/route_contract.mjs" "$RENDER_DIR/lib/route_contract.mjs"
cp "$SCRIPT_DIR/lib/routing_policy.mjs" "$RENDER_DIR/lib/routing_policy.mjs"
cp "$SCRIPT_DIR/lib/stage_tools.mjs" "$RENDER_DIR/lib/stage_tools.mjs"
cp "$SCRIPT_DIR/tools/repo_query.ts" "$RENDER_DIR/tools/repo_query.ts"
cp "$SCRIPT_DIR/plugins/llm_router_prompt_guard.ts" "$RENDER_DIR/plugins/llm_router_prompt_guard.ts"

# Perl reads the replacement values from its environment.
# shellcheck disable=SC2016
LLM_ROUTER_INSTALL_PATH=$ROUTER_PATH \
STAGE_VERIFIER_INSTALL_PATH="$CONFIG_DIR/lib/stage_verifier.py" \
LLM_ROUTER_CONFIG_INSTALL_PATH="$CONFIG_DIR/lib/llm-router-config.json" \
STAGE_LOG_INSTALL_PATH="$CONFIG_DIR/logs/router.jsonl" \
UV_INSTALL_PATH=$UV_PATH \
  "$PERL_PATH" -0pi -e '
    s/__LLM_ROUTER_PATH__/$ENV{"LLM_ROUTER_INSTALL_PATH"}/g;
    s/__STAGE_VERIFIER_PATH__/$ENV{"STAGE_VERIFIER_INSTALL_PATH"}/g;
    s/__LLM_ROUTER_CONFIG_PATH__/$ENV{"LLM_ROUTER_CONFIG_INSTALL_PATH"}/g;
    s/__STAGE_LOG_PATH__/$ENV{"STAGE_LOG_INSTALL_PATH"}/g;
    s/__UV_PATH__/$ENV{"UV_INSTALL_PATH"}/g;
  ' "$RENDER_DIR/tools/llm_route.ts" "$RENDER_DIR/tools/stage_prepare.ts" "$RENDER_DIR/tools/stage_verify.ts" "$RENDER_DIR/lib/stage_tools.mjs"

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

retire_file() {
  local target=$1
  [[ ! -L "$target" ]] || fail "refusing to retire symlink: $target"
  [[ -e "$target" ]] || return 0

  if [[ "$DRY_RUN" == true ]]; then
    printf 'would retire %s (with backup)\n' "$target"
    return
  fi

  "$TRASH_PATH" "$target"
  printf 'retired %s\n' "$target"
}

SOURCES=(
  "$RENDER_DIR/package.json"
  "$RENDER_DIR/lib/claude_agent.mjs"
  "$RENDER_DIR/lib/prompt_guard.mjs"
  "$RENDER_DIR/lib/repo_query.mjs"
  "$RENDER_DIR/lib/route_contract.mjs"
  "$RENDER_DIR/lib/routing_policy.mjs"
  "$RENDER_DIR/lib/stage_tools.mjs"
  "$RENDER_DIR/lib/llm-router-config.json"
  "$RENDER_DIR/lib/stage_verifier.py"
  "$RENDER_DIR/tools/llm_route.ts"
  "$RENDER_DIR/tools/claude_agent.ts"
  "$RENDER_DIR/tools/repo_query.ts"
  "$RENDER_DIR/tools/stage_prepare.ts"
  "$RENDER_DIR/tools/stage_verify.ts"
  "$RENDER_DIR/plugins/llm_router_prompt_guard.ts"
  "$RENDER_DIR/opencode.jsonc"
)
TARGETS=(
  "$CONFIG_DIR/package.json"
  "$CONFIG_DIR/lib/claude_agent.mjs"
  "$CONFIG_DIR/lib/prompt_guard.mjs"
  "$CONFIG_DIR/lib/repo_query.mjs"
  "$CONFIG_DIR/lib/route_contract.mjs"
  "$CONFIG_DIR/lib/routing_policy.mjs"
  "$CONFIG_DIR/lib/stage_tools.mjs"
  "$CONFIG_DIR/lib/llm-router-config.json"
  "$CONFIG_DIR/lib/stage_verifier.py"
  "$CONFIG_DIR/tools/llm_route.ts"
  "$CONFIG_DIR/tools/claude_agent.ts"
  "$CONFIG_DIR/tools/repo_query.ts"
  "$CONFIG_DIR/tools/stage_prepare.ts"
  "$CONFIG_DIR/tools/stage_verify.ts"
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.ts"
  "$CONFIG_DIR/opencode.jsonc"
)
RETIRED_TARGETS=(
  "$CONFIG_DIR/plugins/llm_router_prompt_guard.js"
  "$CONFIG_DIR/tools/claude_opus.ts"
  "$CONFIG_DIR/tools/delegate_task.ts"
)

for index in "${!TARGETS[@]}"; do
  preflight_target "${TARGETS[$index]}" "replace"
done
for target in "${RETIRED_TARGETS[@]}"; do
  preflight_target "$target" "retire"
done

if [[ "$DRY_RUN" != true ]]; then
  for index in "${!TARGETS[@]}"; do
    if [[ -e "${TARGETS[$index]}" ]] && ! cmp -s "${SOURCES[$index]}" "${TARGETS[$index]}"; then
      backup_file "${TARGETS[$index]}"
    fi
  done
  for target in "${RETIRED_TARGETS[@]}"; do
    [[ ! -e "$target" ]] || backup_file "$target"
  done
fi

for index in "${!TARGETS[@]}"; do
  sync_file "${SOURCES[$index]}" "${TARGETS[$index]}"
done
for target in "${RETIRED_TARGETS[@]}"; do
  retire_file "$target"
done

if [[ -n "$BACKUP_DIR" ]]; then
  printf 'backup %s\n' "$BACKUP_DIR"
fi
