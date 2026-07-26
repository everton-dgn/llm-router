#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SETUP="$REPO_ROOT/setup.sh"

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-setup-test.XXXXXX")
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

# A run that was supposed to succeed prints what it actually said before failing,
# so a broken stub is diagnosable from the CI log alone.
fail_with_output() {
  printf -- '--- setup.sh output ---\n%s\n-----------------------\n' "$2" >&2
  fail "$1"
}

assert_contains() {
  grep -F -e "$2" <<< "$1" >/dev/null \
    || fail_with_output "output does not contain: $2" "$1"
}

assert_absent() {
  grep -F -e "$2" <<< "$1" >/dev/null \
    && fail_with_output "output should not contain: $2" "$1"
  return 0
}

bash -n "$SETUP" || fail "setup.sh is not valid bash"
bash -n "$0" || fail "this test is not valid bash"

# The repository forbids permanently destructive commands in its shell scripts.
if grep -E '(^|[[:space:]])(rm|rmdir|unlink)([[:space:]]|$)' "$SETUP" >/dev/null; then
  fail "setup.sh contains a permanently destructive command"
fi

HELP=$(bash "$SETUP" --help)
for flag in --dry-run --dev --config-dir --backup-root --router-path --claude-path; do
  assert_contains "$HELP" "$flag"
done

UNKNOWN=$(bash "$SETUP" --nope 2>&1) && fail "setup.sh accepted an unknown option"
assert_contains "$UNKNOWN" "unknown option: --nope"

# Every run below drives stubs instead of the real toolchain, so no test touches
# the OpenCode configuration of the machine.
STUB_BIN="$FIXTURE/bin"
STUB_LOG="$FIXTURE/log"
mkdir -p "$STUB_BIN" "$STUB_LOG"

stub() {
  local name=$1
  local body=$2
  {
    printf '%s\n' '#!/bin/sh'
    printf 'printf "%%s\\n" "$*" >> "%s/%s.log"\n' "$STUB_LOG" "$name"
    printf '%s\n' "$body"
  } > "$STUB_BIN/$name"
  chmod +x "$STUB_BIN/$name"
}

real() {
  local name=$1
  local path
  path=$(command -v "$name") || fail "$name is required to run this test"
  ln -sf "$path" "$STUB_BIN/$name"
}

log_of() {
  cat "$STUB_LOG/$1.log" 2>/dev/null || true
}

reset_logs() {
  : > "$STUB_LOG/pnpm.log"
  : > "$STUB_LOG/ollama.log"
  : > "$STUB_LOG/install.log"
}

# curl, claude, ollama, opencode and pnpm are stubbed below, so they are left
# out here: linking the real binary first would make the stub write through the
# symlink into the system path.
for tool in bash sh jq node sed grep sort cat printf env mkdir chmod dirname; do
  command -v "$tool" >/dev/null 2>&1 && real "$tool"
done

CLASSIFIER_MODEL=$(jq -r '.model' "$REPO_ROOT/config.json")
TAGS_WITH_MODEL=$(jq -nc --arg model "$CLASSIFIER_MODEL" '{models: [{name: $model}]}')
TAGS_WITHOUT_MODEL='{"models":[]}'

# curl answers the Ollama probes; the payload is swapped per case.
TAGS_FILE="$FIXTURE/tags.json"
printf '%s\n' "$TAGS_WITH_MODEL" > "$TAGS_FILE"
stub curl "cat '$TAGS_FILE'"
stub claude 'printf "{\"loggedIn\": true}\n"'
stub ollama 'exit 0'
stub opencode 'exit 0'
stub pnpm 'exit 0'

# A stub installer keeps the run away from the real bundle, which the dedicated
# bundle test already covers.
FAKE_INSTALLER="$FIXTURE/install.sh"
printf '%s\n' '#!/bin/sh' "printf '%s\\n' \"\$*\" >> '$STUB_LOG/install.log'" 'exit 0' \
  > "$FAKE_INSTALLER"
chmod +x "$FAKE_INSTALLER"

# setup.sh calls the installer by path inside the checkout, so the run happens in
# a copy of the repository whose installer is the stub.
WORK="$FIXTURE/repo"
mkdir -p "$WORK/opencode"
cp "$SETUP" "$WORK/setup.sh"
cp "$REPO_ROOT/config.json" "$REPO_ROOT/package.json" "$WORK/"
cp "$REPO_ROOT/opencode/opencode.jsonc" "$WORK/opencode/"
cp "$FAKE_INSTALLER" "$WORK/opencode/install.sh"

# Arguments go to setup.sh, not to env, so a flag never lands in the position
# where env expects a command.
run_setup() {
  env -i \
    PATH="$STUB_BIN" \
    HOME="$FIXTURE/home" \
    TMPDIR="${TMPDIR:-/tmp}" \
    MINIMAX_API_KEY=set \
    ZAI_API_KEY=set \
    bash "$WORK/setup.sh" --config-dir "$FIXTURE/config" "$@" 2>&1
}

# --- a dry run applies nothing and still previews every step -----------------

reset_logs
DRY=$(run_setup --dry-run) || fail_with_output "the dry run failed" "$DRY"
assert_contains "$DRY" "dry run complete"
assert_contains "$DRY" "would run pnpm --dir"
assert_contains "$DRY" "[5/5] local classifier"
assert_contains "$(log_of install)" "--dry-run"
[[ ! -e "$FIXTURE/config" ]] || fail "the dry run created the config directory"
# The bundle dependencies are the step the manual flow used to forget.
assert_absent "$(log_of pnpm)" "--dir"

# --- a real run installs in order and pulls nothing that is already there ----

reset_logs
printf '%s\n' "$TAGS_WITH_MODEL" > "$TAGS_FILE"
FULL=$(run_setup) || fail_with_output "the full run failed" "$FULL"
assert_contains "$FULL" "setup complete"
assert_contains "$FULL" "bundle dependencies installed"
assert_contains "$(log_of pnpm)" "install --frozen-lockfile"
assert_contains "$(log_of pnpm)" "--dir $FIXTURE/config install --no-optional"
# An already present model is never pulled again.
assert_absent "$(log_of ollama)" "pull"

# --- a missing model is pulled, and its name comes from config.json ----------

reset_logs
printf '%s\n' "$TAGS_WITHOUT_MODEL" > "$TAGS_FILE"
PULLED=$(run_setup) || fail_with_output "the run with a missing model failed" "$PULLED"
assert_contains "$PULLED" "pulling $CLASSIFIER_MODEL"
assert_contains "$(log_of ollama)" "pull $CLASSIFIER_MODEL"

# --- the classifier is the last step, so cheap failures come first -----------

reset_logs
printf '%s\n' "$TAGS_WITHOUT_MODEL" > "$TAGS_FILE"
stub pnpm 'exit 1'
BROKEN=$(run_setup) && fail "setup.sh ignored a failing package manager"
assert_contains "$BROKEN" "cannot install the repository dependencies"
# Nothing expensive ran after the cheap failure.
assert_absent "$(log_of ollama)" "pull"
assert_absent "$(log_of install)" "--config-dir"
stub pnpm 'exit 0'

# --- a failing bundle installer stops before the bundle dependencies ---------

reset_logs
printf '%s\n' '#!/bin/sh' "printf '%s\\n' \"\$*\" >> '$STUB_LOG/install.log'" 'exit 1' \
  > "$WORK/opencode/install.sh"
chmod +x "$WORK/opencode/install.sh"
STOPPED=$(run_setup) && fail "setup.sh continued after the bundle installer failed"
assert_contains "$STOPPED" "the bundle installer stopped"
assert_contains "$STOPPED" "opencode auth login"
assert_absent "$(log_of pnpm)" "--dir"
cp "$FAKE_INSTALLER" "$WORK/opencode/install.sh"

# --- missing prerequisites name the command that fixes them ------------------

PNPM_PIN=$(jq -r '.packageManager' "$REPO_ROOT/package.json")
mv "$STUB_BIN/pnpm" "$FIXTURE/pnpm.hidden"
NO_PNPM=$(run_setup) && fail "setup.sh ran without a package manager"
assert_contains "$NO_PNPM" "corepack prepare $PNPM_PIN --activate"
mv "$FIXTURE/pnpm.hidden" "$STUB_BIN/pnpm"

BAD_CLAUDE=$(env -i \
  PATH="$STUB_BIN" \
  HOME="$FIXTURE/home" \
  TMPDIR="${TMPDIR:-/tmp}" \
  bash "$WORK/setup.sh" --config-dir "$FIXTURE/config" \
  --claude-path "$FIXTURE/tags.json" 2>&1) \
  && fail "setup.sh accepted a --claude-path that cannot be executed"
assert_contains "$BAD_CLAUDE" "not an executable file"

mv "$STUB_BIN/ollama" "$FIXTURE/ollama.hidden"
stub curl 'exit 7'
NO_OLLAMA=$(run_setup) && fail "setup.sh ran with no reachable classifier"
assert_contains "$NO_OLLAMA" "Ollama is not installed"
assert_contains "$NO_OLLAMA" "brew install ollama"
mv "$FIXTURE/ollama.hidden" "$STUB_BIN/ollama"
stub curl "cat '$TAGS_FILE'"

# --- unresolved manual steps are listed with their exact command -------------

reset_logs
printf '%s\n' "$TAGS_WITH_MODEL" > "$TAGS_FILE"
stub claude 'printf "{\"loggedIn\": false}\n"'
PENDING=$(env -i \
  PATH="$STUB_BIN" \
  HOME="$FIXTURE/home" \
  TMPDIR="${TMPDIR:-/tmp}" \
  bash "$WORK/setup.sh" --config-dir "$FIXTURE/config" 2>&1) \
  || fail_with_output "setup.sh failed on steps it should only report" "$PENDING"
assert_contains "$PENDING" "still required (3)"
assert_contains "$PENDING" "claude auth login"
assert_contains "$PENDING" "export MINIMAX_API_KEY"
assert_contains "$PENDING" "export ZAI_API_KEY"
stub claude 'printf "{\"loggedIn\": true}\n"'

SATISFIED=$(run_setup) || fail_with_output "the satisfied run failed" "$SATISFIED"
assert_absent "$SATISFIED" "still required"

printf 'PASS: single-command setup previews, installs in order, and reports what stays manual\n'
