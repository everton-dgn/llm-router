#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-smoke.XXXXXX")
preserve_fixture() {
  [[ ! -d "$TEST_TMP" ]] \
    || mv "$TEST_TMP" "$TEST_TMP.preserved" >/dev/null 2>&1 \
    || true
}
trap preserve_fixture EXIT

fail() {
  printf 'FAILED: %s\n' "$*" >&2
  exit 1
}

FAKE_BIN="$TEST_TMP/bin"
mkdir -p "$FAKE_BIN"
tee "$FAKE_BIN/curl" >/dev/null <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail

body=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d)
      body=$2
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -n "${CURL_BODY_FILE:-}" ]]; then
  printf '%s\n' "$body" | tee "$CURL_BODY_FILE" >/dev/null
fi

if jq -e '.format.properties.summary' <<<"$body" >/dev/null 2>&1; then
  case "${FAKE_SUMMARY_MODE:-valid}" in
    valid)
      printf '%s\n' '{"message":{"content":"{\"summary\":\"Porta 4317; Manual fixo; validar compactação.\"}"}}'
      ;;
    invalid)
      printf '%s\n' '{"message":{"content":"{\"unexpected\":true}"}}'
      ;;
    unavailable)
      exit 7
      ;;
  esac
  exit 0
fi

case "${FAKE_ROUTE_MODE:-glm}" in
  glm)
    printf '%s\n' '{"message":{"content":"{\"route\":[\"translation_simple_brainstorm_docs_or_intermediate_work\"]}"}}'
    ;;
  empty)
    printf '%s\n' '{"message":{"content":"{\"route\":[]}"}}'
    ;;
  invalid)
    printf '%s\n' '{"message":{"content":"{\"route\":[\"invalid_intent\"]}"}}'
    ;;
esac
FAKE_CURL
chmod +x "$FAKE_BIN/curl"

printf '%s\n' '1/12 help is complete and does not query the classifier'
HELP_MARKER="$TEST_TMP/help-body.json"
HELP_OUTPUT=$(CURL_BODY_FILE="$HELP_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" help)
[[ "$HELP_OUTPUT" == *'route --classify --json "prompt"'* ]] || fail "help did not show the JSON contract"
[[ "$HELP_OUTPUT" == *'route --summarize --json'* ]] || fail "help did not show the checkpoint contract"
[[ "$HELP_OUTPUT" == *"MiniMax M3"* ]] || fail "help did not show the routes"
[[ "$HELP_OUTPUT" != *"--auto"* ]] || fail "help still advertises --auto"
[[ "$HELP_OUTPUT" != *"--run"* ]] || fail "help still advertises --run"
[[ ! -e "$HELP_MARKER" ]] || fail "help queried the classifier"

printf '%s\n' '2/12 human-readable output shows the route and configured model'
HUMAN_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "traduza este texto")
[[ "$HUMAN_OUTPUT" == "route:    glm  ->  GLM 5.2" ]] || fail "unexpected human-readable output: $HUMAN_OUTPUT"

printf '%s\n' '3/12 JSON contract is closed and versioned'
JSON_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "traduza este texto")
jq -e '
  . == {
    schema_version: 1,
    intent: "translation_simple_brainstorm_docs_or_intermediate_work",
    route: "glm"
  }
' <<<"$JSON_OUTPUT" >/dev/null || fail "unexpected JSON contract: $JSON_OUTPUT"

printf '%s\n' '4/12 original request reaches the classifier unchanged'
BODY_FILE="$TEST_TMP/request-body.json"
ORIGINAL_REQUEST=$'primeira linha\nsegunda linha com "aspas"'
CURL_BODY_FILE="$BODY_FILE" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --classify --json "$ORIGINAL_REQUEST" >/dev/null
CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$BODY_FILE")
grep -F "$ORIGINAL_REQUEST" <<<"$CLASSIFIER_PROMPT" >/dev/null || fail "original request was rewritten"

printf '%s\n' '5/12 -- preserves prompts that look like flags or help'
for literal_prompt in 'help' '--help' '--compare=modelos'; do
  FLAG_BODY="$TEST_TMP/flag-${literal_prompt//[^a-zA-Z0-9]/_}.json"
  CURL_BODY_FILE="$FLAG_BODY" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
    "$REPO_ROOT/route" --classify --json -- "$literal_prompt" >/dev/null
  FLAG_CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$FLAG_BODY")
  grep -F -- "$literal_prompt" <<<"$FLAG_CLASSIFIER_PROMPT" >/dev/null || fail "literal prompt was interpreted as a flag: $literal_prompt"
done

printf '%s\n' '6/12 empty response produces a structured JSON error'
if EMPTY_OUTPUT=$(FAKE_ROUTE_MODE=empty PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "teste" 2>&1); then
  fail "empty classifier response was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_classifier_response"' \
  <<<"$EMPTY_OUTPUT" >/dev/null || fail "structured error is missing: $EMPTY_OUTPUT"

printf '%s\n' '7/12 removed modes and JSON without classify fail before the classifier'
for raw_args in '--run teste' '--auto teste' '--json teste'; do
  read -r -a args <<<"$raw_args"
  if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "${args[@]}" >/dev/null 2>&1; then
    fail "removed mode was accepted: $raw_args"
  fi
done

printf '%s\n' '8/12 local checkpoint receives JSON through stdin and retains the golden set'
CHECKPOINT_INPUT='{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-3","selected_message_count":3},"prior_compaction_ids":[],"messages":[{"role":"user","content":"A porta é 4317."},{"role":"assistant","content":"Manual fixo."},{"role":"user","content":"Validar compactação."}]}'
SUMMARY_BODY="$TEST_TMP/summary-body.json"
SUMMARY_OUTPUT=$(CURL_BODY_FILE="$SUMMARY_BODY" FAKE_SUMMARY_MODE=valid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT")
jq -e '. == {schema_version:1,summary:"Porta 4317; Manual fixo; validar compactação."}' \
  <<<"$SUMMARY_OUTPUT" >/dev/null || fail "unexpected checkpoint JSON: $SUMMARY_OUTPUT"
SUMMARY_PROMPT=$(jq -r '.messages[0].content' "$SUMMARY_BODY")
grep -F '4317' <<<"$SUMMARY_PROMPT" >/dev/null || fail "fact was lost before the summarizer"
grep -F 'Manual fixo' <<<"$SUMMARY_PROMPT" >/dev/null || fail "decision was lost before the summarizer"
CHECKPOINT_2_INPUT='{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-4","selected_message_count":2,"previous_compaction_id":"compaction-1"},"prior_compaction_ids":["compaction-1"],"messages":[{"role":"assistant","content":"Previous verified checkpoint: porta 4317 e Manual fixo."},{"role":"user","content":"Nova pendência: revisar o fallback."}]}'
CHECKPOINT_2_BODY="$TEST_TMP/summary-2-body.json"
CURL_BODY_FILE="$CHECKPOINT_2_BODY" FAKE_SUMMARY_MODE=valid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_2_INPUT" >/dev/null
CHECKPOINT_2_PROMPT=$(jq -r '.messages[0].content' "$CHECKPOINT_2_BODY")
grep -F 'Previous verified checkpoint' <<<"$CHECKPOINT_2_PROMPT" >/dev/null \
  || fail "previous checkpoint did not reach the next compaction"

printf '%s\n' '9/12 checkpoint rejects invalid input before querying the model'
INVALID_MARKER="$TEST_TMP/invalid-summary-body.json"
if CURL_BODY_FILE="$INVALID_MARKER" PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json \
  <<<'{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-1","selected_message_count":1},"prior_compaction_ids":[],"messages":[{"role":"user","content":"pedido"}],"system":"FORBIDDEN_SECRET"}' \
  >/dev/null 2>&1; then
  fail "checkpoint accepted invalid input"
fi
[[ ! -e "$INVALID_MARKER" ]] || fail "invalid checkpoint queried the model"

printf '%s\n' '10/12 invalid summarizer output produces a structured JSON error'
if SUMMARY_ERROR=$(FAKE_SUMMARY_MODE=invalid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "invalid summarizer output was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_summary_response"' \
  <<<"$SUMMARY_ERROR" >/dev/null || fail "structured summary error is missing: $SUMMARY_ERROR"

printf '%s\n' '11/12 summarizer unavailability produces a structured error'
if SUMMARY_UNAVAILABLE=$(FAKE_SUMMARY_MODE=unavailable PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "unavailable summarizer was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "summarizer_unavailable"' \
  <<<"$SUMMARY_UNAVAILABLE" >/dev/null || fail "unavailability error is missing: $SUMMARY_UNAVAILABLE"

printf '%s\n' '12/12 deterministic verifier passes the focused suite'
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py

printf '%s\n' 'smoke: OK'
