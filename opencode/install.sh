#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
DRY_RUN=false
CONFIG_DIR=""
BACKUP_ROOT="/tmp/claude-backups"
ROUTER_PATH=""
CLAUDE_PATH=""
OPENCODE_PATH=""
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
  --claude-path PATH      Claude executable. Defaults to command -v claude.
  --opencode-path PATH    OpenCode executable. Defaults to command -v opencode.
  -h, --help              Show this help.

Existing changed files are copied to a timestamped backup before replacement.
An identical installation is left untouched and creates no backup.
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
    --opencode-path)
      require_value "$@"
      OPENCODE_PATH=$2
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
[[ -n "$OPENCODE_PATH" ]] || OPENCODE_PATH=$(command -v opencode || true)

[[ -x "$ROUTER_PATH" ]] || fail "llm-router executable not found: $ROUTER_PATH"
[[ -n "$CLAUDE_PATH" && -x "$CLAUDE_PATH" ]] || fail "Claude executable not found; pass --claude-path"
[[ -n "$OPENCODE_PATH" && -x "$OPENCODE_PATH" ]] || fail "OpenCode executable not found; pass --opencode-path"
PERL_PATH=$(command -v perl || true)
TRASH_PATH=$(command -v trash || true)
[[ -n "$PERL_PATH" ]] || fail "perl is required to render executable paths"
[[ -n "$TRASH_PATH" ]] || fail "trash is required for recoverable temporary cleanup"

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
mkdir -p "$RENDER_DIR/tools" "$RENDER_DIR/lib"
cp "$SCRIPT_DIR/opencode.jsonc" "$RENDER_DIR/opencode.jsonc"
cp "$SCRIPT_DIR/tools/llm_route.ts" "$RENDER_DIR/tools/llm_route.ts"
cp "$SCRIPT_DIR/tools/claude_opus.ts" "$RENDER_DIR/tools/claude_opus.ts"
cp "$SCRIPT_DIR/tools/delegate_task.ts" "$RENDER_DIR/tools/delegate_task.ts"
cp "$SCRIPT_DIR/lib/routing_policy.mjs" "$RENDER_DIR/lib/routing_policy.mjs"

# Perl reads the replacement values from its environment.
# shellcheck disable=SC2016
LLM_ROUTER_INSTALL_PATH=$ROUTER_PATH \
CLAUDE_INSTALL_PATH=$CLAUDE_PATH \
OPENCODE_INSTALL_PATH=$OPENCODE_PATH \
  "$PERL_PATH" -0pi -e '
    s/__LLM_ROUTER_PATH__/$ENV{"LLM_ROUTER_INSTALL_PATH"}/g;
    s/__CLAUDE_PATH__/$ENV{"CLAUDE_INSTALL_PATH"}/g;
    s/__OPENCODE_PATH__/$ENV{"OPENCODE_INSTALL_PATH"}/g;
  ' "$RENDER_DIR/tools/llm_route.ts" "$RENDER_DIR/tools/claude_opus.ts" "$RENDER_DIR/tools/delegate_task.ts"

if grep -R -E '__[A-Z0-9_]+__' "$RENDER_DIR" >/dev/null; then
  fail "unresolved installation placeholder in rendered bundle"
fi

ensure_backup_dir() {
  local candidate
  [[ -n "$BACKUP_DIR" ]] && return
  mkdir -p "$BACKUP_ROOT"
  while true; do
    candidate="$BACKUP_ROOT/$(date +%Y%m%d_%H%M%S)"
    if mkdir "$candidate" 2>/dev/null; then
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
  mkdir -p "$BACKUP_DIR/$(dirname "$relative")"
  cp -p "$target" "$BACKUP_DIR/$relative"
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
  if [[ "$action" == update ]]; then
    backup_file "$target"
  fi
  PENDING_TARGET="$target.llm-router.$$"
  cp "$source" "$PENDING_TARGET"
  mv -f "$PENDING_TARGET" "$target"
  PENDING_TARGET=""
  printf '%s %s\n' "$action" "$target"
}

sync_file "$RENDER_DIR/opencode.jsonc" "$CONFIG_DIR/opencode.jsonc"
sync_file "$RENDER_DIR/lib/routing_policy.mjs" "$CONFIG_DIR/lib/routing_policy.mjs"
sync_file "$RENDER_DIR/tools/llm_route.ts" "$CONFIG_DIR/tools/llm_route.ts"
sync_file "$RENDER_DIR/tools/claude_opus.ts" "$CONFIG_DIR/tools/claude_opus.ts"
sync_file "$RENDER_DIR/tools/delegate_task.ts" "$CONFIG_DIR/tools/delegate_task.ts"

if [[ -n "$BACKUP_DIR" ]]; then
  printf 'backup %s\n' "$BACKUP_DIR"
fi
