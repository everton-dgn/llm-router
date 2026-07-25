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
    printf '%s\n' '{"message":{"content":"{\"route\":[\"missing\"]}"}}'
    ;;
esac
FAKE_CURL
chmod +x "$FAKE_BIN/curl"

printf '%s\n' '1/15 help is complete and does not query the classifier'
HELP_MARKER="$TEST_TMP/help-body.json"
HELP_OUTPUT=$(CURL_BODY_FILE="$HELP_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" help)
[[ "$HELP_OUTPUT" == *'route --classify --json "prompt"'* ]] || fail "help did not show the JSON contract"
[[ "$HELP_OUTPUT" == *'route --summarize --json'* ]] || fail "help did not show the checkpoint contract"
FIRST_ROUTE_LABEL=$(jq -r '.routes | sort_by(.order) | first | .display_name' "$REPO_ROOT/config.json")
[[ "$HELP_OUTPUT" == *"$FIRST_ROUTE_LABEL"* ]] || fail "help did not show the routes"
[[ "$HELP_OUTPUT" != *"--auto"* ]] || fail "help still advertises --auto"
[[ "$HELP_OUTPUT" != *"--run"* ]] || fail "help still advertises --run"
[[ ! -e "$HELP_MARKER" ]] || fail "help queried the classifier"

printf '%s\n' '2/15 manifest output is validated and does not query the classifier'
MANIFEST_MARKER="$TEST_TMP/manifest-body.json"
MANIFEST_OUTPUT=$(CURL_BODY_FILE="$MANIFEST_MARKER" PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --manifest --json)
jq -e '
  .schema_version == 2
  and [.routes[].id] == ["minimax", "glm", "claude", "codex"]
  and [.routes[].order] == [0, 1, 2, 3]
  and (.routing | all(.route | type == "string" and length > 0))
  and any(
    .routing[];
    .intent == "translation_simple_brainstorm_docs_or_intermediate_work"
    and .route == "glm"
  )
  and any(
    .routing[];
    .intent == "review_security_hard_engineering_or_technical_writing"
    and .route == "codex"
  )
  and (.routes | all(
    (.target | keys | sort) == ["agent", "modelID", "providerID"]
    and (.capabilities | length) == 7
  ))
' <<<"$MANIFEST_OUTPUT" >/dev/null || fail "unexpected route manifest: $MANIFEST_OUTPUT"
[[ ! -e "$MANIFEST_MARKER" ]] || fail "manifest output queried the classifier"

printf '%s\n' '3/15 schema v1 config expands to the legacy manifest'
LEGACY_CONFIG="$TEST_TMP/config-v1.json"
jq '
  del(.schema_version)
  | .routes |= map({name: .id, display_name})
' \
  "$REPO_ROOT/config.json" | tee "$LEGACY_CONFIG" >/dev/null
LEGACY_MANIFEST=$(LLM_ROUTER_CONFIG="$LEGACY_CONFIG" PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --manifest --json)
jq -e '
  [.routes[].id] == ["minimax", "glm", "claude", "codex"]
  and [.routes[].order] == [0, 1, 2, 3]
  and (.schema_version == 2)
  and (.routing | all(.route | type == "string" and length > 0))
' <<<"$LEGACY_MANIFEST" >/dev/null || fail "schema v1 fallback changed: $LEGACY_MANIFEST"

printf '%s\n' '4/15 invalid manifest fails closed with a named error'
INVALID_MANIFEST_CONFIG="$TEST_TMP/config-invalid-manifest.json"
jq '.routes[1].order = 0' "$REPO_ROOT/config.json" \
  | tee "$INVALID_MANIFEST_CONFIG" >/dev/null
if INVALID_MANIFEST_OUTPUT=$(LLM_ROUTER_CONFIG="$INVALID_MANIFEST_CONFIG" \
  PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --manifest --json 2>&1); then
  fail "duplicate route order was accepted"
fi
grep -F 'route_manifest_error[duplicate_order]' <<<"$INVALID_MANIFEST_OUTPUT" >/dev/null \
  || fail "named manifest error is missing: $INVALID_MANIFEST_OUTPUT"

NULL_SCHEMA_CONFIG="$TEST_TMP/config-null-schema.json"
jq '.schema_version = null' "$REPO_ROOT/config.json" \
  | tee "$NULL_SCHEMA_CONFIG" >/dev/null
if NULL_SCHEMA_OUTPUT=$(LLM_ROUTER_CONFIG="$NULL_SCHEMA_CONFIG" \
  PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --manifest --json 2>&1); then
  fail "explicit null schema version was accepted as legacy"
fi
grep -F 'route_manifest_error[unsupported_schema_version]' \
  <<<"$NULL_SCHEMA_OUTPUT" >/dev/null \
  || fail "null schema version did not report the version error: $NULL_SCHEMA_OUTPUT"

EMPTY_DISPLAY_CONFIG="$TEST_TMP/config-empty-display.json"
jq '.routes[0].display_name = " "' "$REPO_ROOT/config.json" \
  | tee "$EMPTY_DISPLAY_CONFIG" >/dev/null
if EMPTY_DISPLAY_OUTPUT=$(LLM_ROUTER_CONFIG="$EMPTY_DISPLAY_CONFIG" \
  PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --manifest --json 2>&1); then
  fail "empty route display_name was accepted"
fi
grep -F 'route_manifest_error[invalid_display_name]' \
  <<<"$EMPTY_DISPLAY_OUTPUT" >/dev/null \
  || fail "empty display_name did not report its named error: $EMPTY_DISPLAY_OUTPUT"

RESERVED_AGENT_CONFIG="$TEST_TMP/config-reserved-agent.json"
jq '.routes[0].target.agent = "router"' "$REPO_ROOT/config.json" \
  | tee "$RESERVED_AGENT_CONFIG" >/dev/null
if RESERVED_AGENT_OUTPUT=$(LLM_ROUTER_CONFIG="$RESERVED_AGENT_CONFIG" \
  PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --manifest --json 2>&1); then
  fail "reserved router control agent was accepted as a route target"
fi
grep -F 'route_manifest_error[reserved_target_agent]' \
  <<<"$RESERVED_AGENT_OUTPUT" >/dev/null \
  || fail "reserved target agent did not report its named error: $RESERVED_AGENT_OUTPUT"

printf '%s\n' '5/15 human-readable output shows the route and configured model'
HUMAN_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "implemente esta alteração")
[[ "$HUMAN_OUTPUT" == "route:    glm  ->  GLM 5.2" ]] || fail "unexpected human-readable output: $HUMAN_OUTPUT"

printf '%s\n' '6/15 JSON contract is closed and versioned'
JSON_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "implemente esta alteração")
jq -e '
  . == {
    schema_version: 1,
    intent: "translation_simple_brainstorm_docs_or_intermediate_work",
    route: "glm"
  }
' <<<"$JSON_OUTPUT" >/dev/null || fail "unexpected JSON contract: $JSON_OUTPUT"

printf '%s\n' '7/15 original request reaches the classifier unchanged'
BODY_FILE="$TEST_TMP/request-body.json"
ORIGINAL_REQUEST=$'primeira linha\nsegunda linha com "aspas"'
CURL_BODY_FILE="$BODY_FILE" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --classify --json "$ORIGINAL_REQUEST" >/dev/null
CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$BODY_FILE")
grep -F "$ORIGINAL_REQUEST" <<<"$CLASSIFIER_PROMPT" >/dev/null || fail "original request was rewritten"
grep -F 'Simple brainstorming and simple documentation' \
  <<<"$CLASSIFIER_PROMPT" >/dev/null \
  || fail "classifier prompt does not preserve the simple-work route"
grep -F 'Threat modeling and security analysis always use the review and hard-engineering route' \
  <<<"$CLASSIFIER_PROMPT" >/dev/null \
  || fail "classifier prompt does not preserve the security route"
grep -F 'Intermediate social content that requires technical precision uses the engineering technical-writing route.' \
  <<<"$CLASSIFIER_PROMPT" >/dev/null \
  || fail "classifier prompt does not preserve technical writing"

printf '%s\n' '8/15 -- preserves prompts that look like flags or help'
for literal_prompt in 'help' '--help' '--compare=modelos'; do
  FLAG_BODY="$TEST_TMP/flag-${literal_prompt//[^a-zA-Z0-9]/_}.json"
  CURL_BODY_FILE="$FLAG_BODY" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
    "$REPO_ROOT/route" --classify --json -- "$literal_prompt" >/dev/null
  FLAG_CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$FLAG_BODY")
  grep -F -- "$literal_prompt" <<<"$FLAG_CLASSIFIER_PROMPT" >/dev/null || fail "literal prompt was interpreted as a flag: $literal_prompt"
done

printf '%s\n' '9/15 empty response produces a structured JSON error'
if EMPTY_OUTPUT=$(FAKE_ROUTE_MODE=empty PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "teste" 2>&1); then
  fail "empty classifier response was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_classifier_response"' \
  <<<"$EMPTY_OUTPUT" >/dev/null || fail "structured error is missing: $EMPTY_OUTPUT"

printf '%s\n' '10/15 removed modes and JSON without classify fail before the classifier'
for raw_args in '--run teste' '--auto teste' '--json teste'; do
  read -r -a args <<<"$raw_args"
  if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "${args[@]}" >/dev/null 2>&1; then
    fail "removed mode was accepted: $raw_args"
  fi
done

printf '%s\n' '11/15 local checkpoint receives JSON through stdin and retains the golden set'
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

printf '%s\n' '12/15 checkpoint rejects invalid input before querying the model'
INVALID_MARKER="$TEST_TMP/invalid-summary-body.json"
if CURL_BODY_FILE="$INVALID_MARKER" PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json \
  <<<'{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-1","selected_message_count":1},"prior_compaction_ids":[],"messages":[{"role":"user","content":"pedido"}],"system":"FORBIDDEN_SECRET"}' \
  >/dev/null 2>&1; then
  fail "checkpoint accepted invalid input"
fi
[[ ! -e "$INVALID_MARKER" ]] || fail "invalid checkpoint queried the model"

printf '%s\n' '13/15 invalid summarizer output produces a structured JSON error'
if SUMMARY_ERROR=$(FAKE_SUMMARY_MODE=invalid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "invalid summarizer output was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_summary_response"' \
  <<<"$SUMMARY_ERROR" >/dev/null || fail "structured summary error is missing: $SUMMARY_ERROR"

printf '%s\n' '14/15 summarizer unavailability produces a structured error'
if SUMMARY_UNAVAILABLE=$(FAKE_SUMMARY_MODE=unavailable PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "unavailable summarizer was accepted"
fi
jq -e '.schema_version == 1 and .error.code == "summarizer_unavailable"' \
  <<<"$SUMMARY_UNAVAILABLE" >/dev/null || fail "unavailability error is missing: $SUMMARY_UNAVAILABLE"

printf '%s\n' '15/15 deterministic verifier passes the focused suite'
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py

printf '%s\n' 'smoke: OK'
