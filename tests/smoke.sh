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

printf '%s\n' '1/8 help é completo e não consulta o classificador'
HELP_MARKER="$TEST_TMP/help-body.json"
HELP_OUTPUT=$(CURL_BODY_FILE="$HELP_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" help)
[[ "$HELP_OUTPUT" == *'route --classify --json "prompt"'* ]] || fail "help não mostrou o contrato JSON"
[[ "$HELP_OUTPUT" == *"MiniMax M3"* ]] || fail "help não mostrou as rotas"
[[ "$HELP_OUTPUT" != *"--auto"* ]] || fail "help ainda anuncia --auto"
[[ "$HELP_OUTPUT" != *"--run"* ]] || fail "help ainda anuncia --run"
[[ ! -e "$HELP_MARKER" ]] || fail "help consultou o classificador"

printf '%s\n' '2/8 saída humana mostra a rota e o modelo configurado'
HUMAN_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" "traduza este texto")
[[ "$HUMAN_OUTPUT" == "rota:     glm  ->  GLM 5.2" ]] || fail "saída humana inesperada: $HUMAN_OUTPUT"

printf '%s\n' '3/8 contrato JSON é fechado e versionado'
JSON_OUTPUT=$(FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "traduza este texto")
jq -e '
  . == {
    schema_version: 1,
    intent: "translation_simple_brainstorm_docs_or_intermediate_work",
    route: "glm"
  }
' <<<"$JSON_OUTPUT" >/dev/null || fail "contrato JSON inesperado: $JSON_OUTPUT"

printf '%s\n' '4/8 pedido original chega intacto ao classificador'
BODY_FILE="$TEST_TMP/request-body.json"
ORIGINAL_REQUEST=$'primeira linha\nsegunda linha com "aspas"'
CURL_BODY_FILE="$BODY_FILE" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
  "$REPO_ROOT/route" --classify --json "$ORIGINAL_REQUEST" >/dev/null
CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$BODY_FILE")
grep -F "$ORIGINAL_REQUEST" <<<"$CLASSIFIER_PROMPT" >/dev/null || fail "pedido original foi reescrito"

printf '%s\n' '5/8 -- preserva prompts que parecem flags ou help'
for literal_prompt in 'help' '--help' '--compare=modelos'; do
  FLAG_BODY="$TEST_TMP/flag-${literal_prompt//[^a-zA-Z0-9]/_}.json"
  CURL_BODY_FILE="$FLAG_BODY" FAKE_ROUTE_MODE=glm PATH="$FAKE_BIN:$PATH" \
    "$REPO_ROOT/route" --classify --json -- "$literal_prompt" >/dev/null
  FLAG_CLASSIFIER_PROMPT=$(jq -r '.messages[0].content' "$FLAG_BODY")
  grep -F -- "$literal_prompt" <<<"$FLAG_CLASSIFIER_PROMPT" >/dev/null || fail "prompt literal foi interpretado como flag: $literal_prompt"
done

printf '%s\n' '6/8 resposta vazia gera erro JSON estruturado'
if EMPTY_OUTPUT=$(FAKE_ROUTE_MODE=empty PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" --classify --json "teste" 2>&1); then
  fail "classificador vazio foi aceito"
fi
jq -e '.schema_version == 1 and .error.code == "invalid_classifier_response"' \
  <<<"$EMPTY_OUTPUT" >/dev/null || fail "erro estruturado ausente: $EMPTY_OUTPUT"

printf '%s\n' '7/8 modos removidos e JSON sem classify falham antes do classificador'
for args in '--run teste' '--auto teste' '--json teste'; do
  if PATH="$FAKE_BIN:$PATH" "$REPO_ROOT/route" $args >/dev/null 2>&1; then
    fail "modo removido foi aceito: $args"
  fi
done

printf '%s\n' '8/8 verificador determinístico passa na suíte focada'
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py

printf '%s\n' 'smoke: OK'
