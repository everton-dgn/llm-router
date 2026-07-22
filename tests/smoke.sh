#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
TRASH_PATH=$(command -v trash || true)
[[ -n "$TRASH_PATH" ]] || { printf 'FALHOU: trash é obrigatório\n' >&2; exit 1; }

TEST_TMP=$(mktemp -d "${TMPDIR:-/tmp}/llm-router-smoke.XXXXXX")
cleanup() {
  [[ ! -d "$TEST_TMP" ]] || "$TRASH_PATH" "$TEST_TMP" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'FALHOU: %s\n' "$*" >&2
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

printf '%s\n' '1/12 help é completo e não consulta o classificador'
HELP_MARKER="$TEST_TMP/help-body.json"
HELP_OUTPUT=$(CURL_BODY_FILE="$HELP_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" help)
[[ "$HELP_OUTPUT" == *'route --classify --json "prompt"'* ]] || fail "help não mostrou o contrato JSON"
[[ "$HELP_OUTPUT" == *'route --summarize --json'* ]] || fail "help não mostrou o contrato de checkpoint"
[[ "$HELP_OUTPUT" == *"MiniMax M3"* ]] || fail "help não mostrou as rotas"
[[ "$HELP_OUTPUT" != *"--auto"* ]] || fail "help ainda anuncia --auto"
[[ "$HELP_OUTPUT" != *"--run"* ]] || fail "help ainda anuncia --run"
[[ ! -e "$HELP_MARKER" ]] || fail "help consultou o classificador"

printf '%s\n' '2/12 saída humana mostra a rota e o modelo configurado'
HUMAN_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "traduza este texto")
[[ "$HUMAN_OUTPUT" == "rota:     glm  ->  GLM 5.2" ]] || fail "saída humana inesperada: $HUMAN_OUTPUT"

printf '%s\n' '3/12 contrato JSON é fechado e versionado'
JSON_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "traduza este texto")
jq -e '
  . == {
    schema_version: 1,
    intent: "translation_simple_brainstorm_docs_or_intermediate_work",
    route: "glm"
  }
' <<<"$JSON_OUTPUT" >/dev/null || fail "contrato JSON inesperado: $JSON_OUTPUT"

printf '%s\n' '4/12 pedido original chega intacto ao classificador'
BODY_FILE="$TEST_TMP/request-body.json"
ORIGINAL_REQUEST=$'primeira linha\nsegunda linha com "aspas"'
CURL_BODY_FILE="$BODY_FILE" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --classify --json "$ORIGINAL_REQUEST" >/dev/null
CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$BODY_FILE")
grep -F "$ORIGINAL_REQUEST" <<<"$CLASSIFIER_PROMPT" >/dev/null || fail "pedido original foi reescrito"

printf '%s\n' '5/12 -- preserva prompts que parecem flags ou help'
for literal_prompt in 'help' '--help' '--compare=modelos'; do
  FLAG_BODY="$TEST_TMP/flag-${literal_prompt//[^a-zA-Z0-9]/_}.json"
  CURL_BODY_FILE="$FLAG_BODY" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
    "$REPO_ROOT/route" --classify --json -- "$literal_prompt" >/dev/null
  FLAG_CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$FLAG_BODY")
  grep -F -- "$literal_prompt" <<<"$FLAG_CLASSIFIER_PROMPT" >/dev/null || fail "prompt literal foi interpretado como flag: $literal_prompt"
done

printf '%s\n' '6/12 resposta vazia gera erro JSON estruturado'
if EMPTY_OUTPUT=$(FAKE_ROUTE_MODE=empty PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "teste" 2>&1); then
  fail "classificador vazio foi aceito"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_classifier_response"' \
  <<<"$EMPTY_OUTPUT" >/dev/null || fail "erro estruturado ausente: $EMPTY_OUTPUT"

printf '%s\n' '7/12 modos removidos e JSON sem classify falham antes do classificador'
for raw_args in '--run teste' '--auto teste' '--json teste'; do
  read -r -a args <<<"$raw_args"
  if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "${args[@]}" >/dev/null 2>&1; then
    fail "modo removido foi aceito: $raw_args"
  fi
done

printf '%s\n' '8/12 checkpoint local recebe JSON por stdin e retém o conjunto dourado'
CHECKPOINT_INPUT='{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-3","selected_message_count":3},"prior_compaction_ids":[],"messages":[{"role":"user","content":"A porta é 4317."},{"role":"assistant","content":"Manual fixo."},{"role":"user","content":"Validar compactação."}]}'
SUMMARY_BODY="$TEST_TMP/summary-body.json"
SUMMARY_OUTPUT=$(CURL_BODY_FILE="$SUMMARY_BODY" FAKE_SUMMARY_MODE=valid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT")
jq -e '. == {schema_version:1,summary:"Porta 4317; Manual fixo; validar compactação."}' \
  <<<"$SUMMARY_OUTPUT" >/dev/null || fail "checkpoint JSON inesperado: $SUMMARY_OUTPUT"
SUMMARY_PROMPT=$(jq -r '.messages[0].content' "$SUMMARY_BODY")
grep -F '4317' <<<"$SUMMARY_PROMPT" >/dev/null || fail "fato foi perdido antes do sumarizador"
grep -F 'Manual fixo' <<<"$SUMMARY_PROMPT" >/dev/null || fail "decisão foi perdida antes do sumarizador"
CHECKPOINT_2_INPUT='{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-4","selected_message_count":2,"previous_compaction_id":"compaction-1"},"prior_compaction_ids":["compaction-1"],"messages":[{"role":"assistant","content":"Previous verified checkpoint: porta 4317 e Manual fixo."},{"role":"user","content":"Nova pendência: revisar o fallback."}]}'
CHECKPOINT_2_BODY="$TEST_TMP/summary-2-body.json"
CURL_BODY_FILE="$CHECKPOINT_2_BODY" FAKE_SUMMARY_MODE=valid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_2_INPUT" >/dev/null
CHECKPOINT_2_PROMPT=$(jq -r '.messages[0].content' "$CHECKPOINT_2_BODY")
grep -F 'Previous verified checkpoint' <<<"$CHECKPOINT_2_PROMPT" >/dev/null \
  || fail "checkpoint anterior não chegou à compactação seguinte"

printf '%s\n' '9/12 checkpoint rejeita entrada inválida antes de consultar o modelo'
INVALID_MARKER="$TEST_TMP/invalid-summary-body.json"
if CURL_BODY_FILE="$INVALID_MARKER" PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json \
  <<<'{"schema_version":1,"session_id":"session-1","source":{"first_message_id":"user-1","last_message_id":"user-1","selected_message_count":1},"prior_compaction_ids":[],"messages":[{"role":"user","content":"pedido"}],"system":"FORBIDDEN_SECRET"}' \
  >/dev/null 2>&1; then
  fail "checkpoint aceitou entrada inválida"
fi
[[ ! -e "$INVALID_MARKER" ]] || fail "checkpoint inválido consultou o modelo"

printf '%s\n' '10/12 saída inválida do sumarizador gera erro JSON estruturado'
if SUMMARY_ERROR=$(FAKE_SUMMARY_MODE=invalid PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "sumarizador inválido foi aceito"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_summary_response"' \
  <<<"$SUMMARY_ERROR" >/dev/null || fail "erro de resumo estruturado ausente: $SUMMARY_ERROR"

printf '%s\n' '11/12 indisponibilidade do sumarizador gera erro estruturado'
if SUMMARY_UNAVAILABLE=$(FAKE_SUMMARY_MODE=unavailable PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --summarize --json <<<"$CHECKPOINT_INPUT" 2>&1); then
  fail "sumarizador indisponível foi aceito"
fi
jq -e '.schema_version == 1 and .error.code == "summarizer_unavailable"' \
  <<<"$SUMMARY_UNAVAILABLE" >/dev/null || fail "erro de indisponibilidade ausente: $SUMMARY_UNAVAILABLE"

printf '%s\n' '12/12 verificador determinístico passa na suíte focada'
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py

printf '%s\n' 'smoke: OK'
