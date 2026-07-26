#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT="$SCRIPT_DIR"
DRY_RUN=false
INSTALL_DEV=false
CONFIG_DIR=""
BACKUP_ROOT=""
ROUTER_PATH=""
CLAUDE_PATH=""
STEP=0
STEP_TOTAL=5
TODO_TITLES=()
TODO_COMMANDS=()

show_help() {
  cat <<'HELP'
Set up the llm-router integration for OpenCode with a single command.

Usage:
  bash setup.sh [options]

Options:
  --dry-run           Preview the OpenCode changes without applying them.
  --dev               Also install the development toolchain and the Git hooks.
  --config-dir PATH   OpenCode configuration directory. Defaults to the XDG or user config path.
  --backup-root PATH  Backup root forwarded to the bundle installer.
  --router-path PATH  llm-router executable forwarded to the bundle installer.
  --claude-path PATH  Claude Code executable. Defaults to claude from PATH.
  -h, --help          Show this help.

A missing prerequisite stops the run and names the command that fixes it.
Interactive logins and API keys are never automated; they are listed at the end.
HELP
}

fail() {
  printf 'error: %s\n' "$1" >&2
  shift
  local hint
  for hint in "$@"; do
    printf '  fix: %s\n' "$hint" >&2
  done
  exit 1
}

require_value() {
  [[ $# -ge 2 && -n "$2" ]] || fail "$1 requires a path"
}

step() {
  STEP=$((STEP + 1))
  printf '\n[%d/%d] %s\n' "$STEP" "$STEP_TOTAL" "$1"
}

ok() { printf 'ok   %s\n' "$1"; }
warn() { printf 'warning: %s\n' "$1" >&2; }

todo() {
  TODO_TITLES+=("$1")
  TODO_COMMANDS+=("$2")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --dev) INSTALL_DEV=true; shift ;;
    --config-dir) require_value "$@"; CONFIG_DIR=$2; shift 2 ;;
    --backup-root) require_value "$@"; BACKUP_ROOT=$2; shift 2 ;;
    --router-path) require_value "$@"; ROUTER_PATH=$2; shift 2 ;;
    --claude-path) require_value "$@"; CLAUDE_PATH=$2; shift 2 ;;
    -h|--help) show_help; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

# The bundle installer resolves the same default. Keeping it here avoids parsing
# output that OpenCode does not contract.
if [[ -z "$CONFIG_DIR" ]]; then
  if [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
  else
    CONFIG_DIR="${HOME:?HOME is required}/.config/opencode"
  fi
fi

printf 'llm-router setup\n'
printf 'repository %s\n' "$REPO_ROOT"
printf 'config     %s\n' "$CONFIG_DIR"

# --------------------------------------------------------------- prerequisites

step 'prerequisites'

command -v jq >/dev/null 2>&1 \
  || fail 'jq is required to read config.json and to render the bundle' \
    'macOS: brew install jq' \
    'Debian or Ubuntu: sudo apt-get install jq'
ok "jq $(jq --version)"

command -v node >/dev/null 2>&1 \
  || fail 'node is required to render and validate the bundle' \
    'install a supported Node release from https://nodejs.org'
ok "node $(node --version)"

PNPM_PIN=$(jq -r '.packageManager' "$REPO_ROOT/package.json")
command -v pnpm >/dev/null 2>&1 \
  || fail 'pnpm is required to install dependencies' \
    "corepack enable && corepack prepare $PNPM_PIN --activate"
ok "pnpm $(pnpm --version)"

command -v curl >/dev/null 2>&1 \
  || fail 'curl is required to reach the local classifier' \
    'install curl with your package manager'
ok 'curl'

[[ -n "$CLAUDE_PATH" ]] || CLAUDE_PATH=$(command -v claude || true)
[[ -n "$CLAUDE_PATH" ]] \
  || fail 'Claude Code is required by the claude route' \
    'install Claude Code, then confirm with: claude --version'
ok 'claude'

# The classifier endpoint and models are read from config.json, so a retargeted
# classifier keeps this check correct.
CLASSIFIER_ENDPOINT=$(jq -r '.endpoint' "$REPO_ROOT/config.json")
OLLAMA_BASE=${CLASSIFIER_ENDPOINT%/api/*}
if ! command -v ollama >/dev/null 2>&1 \
  && ! curl -fsS --max-time 5 "$OLLAMA_BASE/api/tags" >/dev/null 2>&1; then
  fail "Ollama is not installed and nothing answers at $OLLAMA_BASE" \
    'macOS: brew install ollama' \
    'Linux: download https://ollama.com/install.sh, read it, then run it' \
    'already installed elsewhere: change "endpoint" in config.json'
fi
ok 'ollama'

command -v opencode >/dev/null 2>&1 \
  || warn 'opencode is not on PATH; the bundle installer cannot confirm route providers'
command -v git >/dev/null 2>&1 \
  || warn 'git is not on PATH; the repo_query tool stays unavailable'

# The bundle installer warns about this too. Collecting it here keeps every
# manual step in one closing list.
CLAUDE_PROFILE=${CLAUDE_CONFIG_DIR:-${HOME:?HOME is required}/.claude}
CLAUDE_AUTH=$(CLAUDE_CONFIG_DIR="$CLAUDE_PROFILE" "$CLAUDE_PATH" auth status 2>/dev/null || true)
grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true' <<< "$CLAUDE_AUTH" \
  || todo 'sign in to Claude Code' \
    "CLAUDE_CONFIG_DIR=$CLAUDE_PROFILE claude auth login"

# The keys come from the bundle configuration, so adding a provider that reads a
# new variable does not need an edit here.
while IFS= read -r key; do
  [[ -n "${!key:-}" ]] \
    || todo "export $key in the shell that starts OpenCode" "export $key=..."
done < <(grep -o '{env:[A-Z_]*}' "$REPO_ROOT/opencode/opencode.jsonc" \
  | sed 's/^{env://;s/}$//' | sort -u)

# ------------------------------------------------------ repository dependencies

step 'repository dependencies'

# The bundle installer imports jsonc-parser from this checkout, so even a dry run
# needs these. Nothing outside the checkout is touched by this step.
PNPM_INSTALL_ENV=()
[[ "$INSTALL_DEV" == true ]] || PNPM_INSTALL_ENV=(CI=1)
(cd "$REPO_ROOT" \
  && env "${PNPM_INSTALL_ENV[@]+"${PNPM_INSTALL_ENV[@]}"}" pnpm install --frozen-lockfile) \
  || fail 'cannot install the repository dependencies' \
    'pnpm install --frozen-lockfile'
ok 'repository dependencies installed (inside this checkout only)'

# -------------------------------------------------------------- OpenCode bundle

step 'OpenCode bundle'

INSTALL_ARGS=(--config-dir "$CONFIG_DIR" --claude-path "$CLAUDE_PATH")
[[ -z "$BACKUP_ROOT" ]] || INSTALL_ARGS+=(--backup-root "$BACKUP_ROOT")
[[ -z "$ROUTER_PATH" ]] || INSTALL_ARGS+=(--router-path "$ROUTER_PATH")
[[ "$DRY_RUN" != true ]] || INSTALL_ARGS+=(--dry-run)
bash "$REPO_ROOT/opencode/install.sh" "${INSTALL_ARGS[@]}" \
  || fail 'the bundle installer stopped and nothing else was changed' \
    'when it named a route provider, sign in with: opencode auth login' \
    "inspect the plan with: bash opencode/install.sh --config-dir $CONFIG_DIR --dry-run"

# ----------------------------------------------------------- bundle dependencies

step 'bundle dependencies'

if [[ "$DRY_RUN" == true ]]; then
  printf 'would run pnpm --dir %s install --no-optional\n' "$CONFIG_DIR"
else
  pnpm --dir "$CONFIG_DIR" install --no-optional \
    || fail 'the bundle is installed but its dependencies are missing, so the plugin will not load' \
      "pnpm --dir $CONFIG_DIR install --no-optional"
  ok 'bundle dependencies installed'
fi

# ------------------------------------------------------------- local classifier

step 'local classifier'

OLLAMA_TAGS=$(curl -fsS --max-time 10 "$OLLAMA_BASE/api/tags" 2>/dev/null) \
  || fail "Ollama is not answering at $OLLAMA_BASE (endpoint read from config.json)" \
    'ollama serve' \
    'running elsewhere: change "endpoint" in config.json'
ok "ollama reachable at $OLLAMA_BASE"

ensure_model() {
  local model=$1
  if jq -e --arg model "$model" '[.models[].name] | index($model) != null' \
    >/dev/null <<< "$OLLAMA_TAGS"; then
    ok "model $model"
    return
  fi
  if [[ "$DRY_RUN" == true ]]; then
    printf 'would pull %s\n' "$model"
    return
  fi
  printf 'pulling %s\n' "$model"
  if command -v ollama >/dev/null 2>&1; then
    ollama pull "$model" || fail "cannot pull the classifier model: $model" "ollama pull $model"
  else
    # A cancelled pull resumes and concurrent pulls share progress, so a repeat
    # is safe.
    curl -fsS --max-time 3600 -X POST "$OLLAMA_BASE/api/pull" \
      -H 'content-type: application/json' \
      --data "$(jq -nc --arg model "$model" '{model: $model, stream: false}')" \
      | jq -e '.status == "success"' >/dev/null \
      || fail "cannot pull the classifier model: $model" "ollama pull $model"
  fi
  ok "pulled $model"
}

while IFS= read -r model; do
  ensure_model "$model"
done < <(jq -r '[.model, .checkpoint.model] | unique | .[]' "$REPO_ROOT/config.json")

# ----------------------------------------------------------------- manual steps

printf '\n'
if [[ "$DRY_RUN" == true ]]; then
  printf 'dry run complete; the OpenCode configuration was not changed\n'
else
  printf 'setup complete\n'
fi

if [[ ${#TODO_TITLES[@]} -gt 0 ]]; then
  printf '\nstill required (%d):\n' "${#TODO_TITLES[@]}"
  index=0
  while [[ $index -lt ${#TODO_TITLES[@]} ]]; do
    printf '  %d. %s\n     %s\n' \
      "$((index + 1))" "${TODO_TITLES[$index]}" "${TODO_COMMANDS[$index]}"
    index=$((index + 1))
  done
fi

printf '\nthe installed plugin runs %s/route\n' "$REPO_ROOT"
printf 'moving this checkout breaks the installation; run setup again after moving it\n'
printf '\nnext: opencode .\n'
