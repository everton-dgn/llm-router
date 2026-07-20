#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$REPO_DIR/auto_runner.py"

command -v jq >/dev/null 2>&1 || { printf '%s\n' 'erro: jq nao encontrado' >&2; exit 1; }
command -v uv >/dev/null 2>&1 || { printf '%s\n' 'erro: uv nao encontrado' >&2; exit 1; }
command -v trash >/dev/null 2>&1 || { printf '%s\n' 'erro: trash nao encontrado' >&2; exit 1; }
[[ -f "$RUNNER" ]] || { printf 'erro: runner nao encontrado em %s\n' "$RUNNER" >&2; exit 1; }

TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/llm-router-smoke.XXXXXX")"

cleanup() {
  [[ ! -e "$TEST_TMP" ]] || trash "$TEST_TMP"
}
trap cleanup EXIT

fail() {
  printf 'FALHOU: %s\n' "$1" >&2
  exit 1
}

assert_jq() {
  local filter="$1"
  local file="$2"
  local message="$3"

  jq -e -s "$filter" "$file" >/dev/null || fail "$message"
}

FAKE_CLI="$TEST_TMP/fake-cli"
tee "$FAKE_CLI" >/dev/null <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
MARKER="${2:-}"
THIRD_MARKER="${3:-}"

case "$MODE" in
  worker-pass)
    cat >/dev/null
    printf '%s\n' '{"type":"result","result":"{\"status\":\"ok\"}"}'
    ;;
  worker-write-auto)
    cat >/dev/null
    printf '%s\n' 'worker change' | tee -a source.auto >/dev/null
    printf '%s\n' '{"type":"result","result":"{\"status\":\"ok\"}"}'
    ;;
  worker-write-ts)
    cat >/dev/null
    printf '%s\n' 'export const workerChange = true;' | tee -a source.ts >/dev/null
    printf '%s\n' '{"type":"result","result":"{\"status\":\"ok\"}"}'
    ;;
  worker-codex)
    cat >/dev/null
    printf '%s\n' '{"status":"ok","source":"codex-file"}' | tee "$MARKER" >/dev/null
    printf '%s\n' '{"type":"item.completed"}'
    ;;
  worker-fail)
    cat >/dev/null
    printf '%s\n' 'falha simulada do worker' >&2
    exit 7
    ;;
  worker-timeout)
    cat >/dev/null
    sleep 3
    printf '%s\n' '{"type":"result","result":"late result"}'
    ;;
  gate-pass)
    exit 0
    ;;
  gate-mark)
    touch "$MARKER"
    exit 0
    ;;
  gate-flaky)
    if [[ ! -e "$MARKER" ]]; then
      touch "$MARKER"
      exit 1
    fi
    exit 0
    ;;
  judge-pass|judge-third|judge-fail|judge-abstain|judge-third-abstain)
    INPUT="$(cat)"
    if [[ "$INPUT" == *"secret-worker-model"* ]]; then
      printf '%s\n' 'identidade do worker vazou para o juiz' >&2
      exit 19
    fi
    [[ -z "$MARKER" ]] || touch "$MARKER"
    if [[ "$MODE" == judge-third* ]]; then
      [[ -z "$THIRD_MARKER" ]] || touch "$THIRD_MARKER"
    fi
    case "$MODE" in
      judge-fail)
        printf '%s\n' '{"type":"result","result":"{\"verdict\":\"fail\",\"confidence\":0.99,\"failures\":[\"simulated failure\"],\"repair_instructions\":[\"repair it\"]}"}'
        ;;
      judge-abstain|judge-third-abstain)
        printf '%s\n' '{"type":"result","result":"{\"verdict\":\"abstain\",\"confidence\":0.99,\"failures\":[],\"repair_instructions\":[]}"}'
        ;;
      *)
        printf '%s\n' '{"type":"result","result":"{\"verdict\":\"pass\",\"confidence\":0.99,\"failures\":[],\"repair_instructions\":[]}"}'
        ;;
    esac
    ;;
  *)
    printf 'modo fake desconhecido: %s\n' "$MODE" >&2
    exit 64
    ;;
esac
FAKE
chmod +x "$FAKE_CLI"

make_config() {
  local case_dir="$1"
  local start_route="$2"
  local worker_mode="$3"
  local ladder_json="$4"
  local default_verifier="$5"
  local max_worker_attempts="$6"
  local retry_count="$7"
  local gates_json="$8"
  local worker_timeout="$9"
  local judge_one_mode="${10:-judge-pass}"
  local judge_two_mode="${11:-judge-pass}"
  local judge_three_mode="${12:-judge-third}"
  local jury_marker="$case_dir/jury.called"
  local third_marker="$case_dir/third.called"

  mkdir -p "$case_dir"
  jq -n \
    --arg fake "$FAKE_CLI" \
    --arg start "$start_route" \
    --arg worker_mode "$worker_mode" \
    --arg verifier "$default_verifier" \
    --arg jury_marker "$jury_marker" \
    --arg third_marker "$third_marker" \
    --arg judge_one_mode "$judge_one_mode" \
    --arg judge_two_mode "$judge_two_mode" \
    --arg judge_three_mode "$judge_three_mode" \
    --argjson ladder "$ladder_json" \
    --argjson max_worker_attempts "$max_worker_attempts" \
    --argjson retry_count "$retry_count" \
    --argjson gates "$gates_json" \
    --argjson worker_timeout "$worker_timeout" '
      def invocation($mode; $timeout; $extra):
        {
          argv: ([$fake, $mode] + $extra),
          output_format: "claude_json",
          timeout_seconds: $timeout
        };
      def route($name; $worker; $judge; $judge_extra):
        {
          name: $name,
          cli: $name,
          description: "smoke fixture",
          headless: {
            env: {},
            worker: invocation($worker; $worker_timeout; []),
            judge: invocation($judge; 2; $judge_extra)
          }
        };
      {
        model: "unused-in-smoke",
        endpoint: "http://127.0.0.1:9/unused",
        default_route: $start,
        options: {temperature: 0, num_predict: 1},
        routes: [
          route($start; $worker_mode; "judge-pass"; [$jury_marker]),
          route("expensive"; "worker-pass"; "judge-pass"; [$jury_marker]),
          route("codex"; "worker-pass"; $judge_one_mode; [$jury_marker]),
          route("claude"; "worker-pass"; $judge_two_mode; [$jury_marker]),
          route("glm"; "worker-pass"; $judge_three_mode; [$jury_marker, $third_marker])
        ],
        auto: {
          max_worker_attempts: $max_worker_attempts,
          max_judge_sessions: 4,
          max_total_sessions: 8,
          max_total_seconds: 12,
          feedback_max_chars: 2000,
          evidence_max_chars: 2000,
          default_verifier: $verifier,
          retry_same_route: {
            max_retries: $retry_count,
            on: ["process_error", "timeout", "fail", "inconclusive"]
          },
          ladders: {($start): $ladder},
          verifiers: {
            layered: {
              type: "layered",
              gates: $gates,
              fallback: "jury",
              on_gate_error: "jury"
            },
            jury: {
              type: "llm_jury",
              blind: true,
              evaluation: "lazy_majority",
              quorum: 2,
              judges: [
                {route: "codex", threshold: 0.85},
                {route: "claude", threshold: 0.85},
                {route: "glm", threshold: 0.80}
              ],
              arbiter: {
                preferred_route: "codex",
                avoid_worker_route: true,
                fallback_route: "claude",
                threshold: 0.85
              },
              feedback: {
                preferred_route: "codex",
                fallback: "majority_failures"
              }
            },
            null: {type: "null"}
          },
          log: {
            path: "logs/auto.jsonl",
            include_prompt: false,
            include_output: false
          }
        }
      }
    ' | tee "$case_dir/config.json" >/dev/null
}

run_auto() {
  local config="$1"
  local route="$2"
  local verifier="$3"
  local run_cwd="${4:-$TEST_TMP}"

  local args=(
    --config "$config"
    --route "$route"
    --prompt "smoke task"
    --cwd "$run_cwd"
  )
  [[ -z "$verifier" ]] || args+=(--verifier "$verifier")
  uv run --no-project --no-python-downloads python "$RUNNER" "${args[@]}"
}

enable_auto_select() {
  local config="$1"
  local rules="$2"
  local updated="$config.auto"

  jq --argjson rules "$rules" '
    .auto.default_verifier = "auto_select" |
    .auto.verifiers.auto_select = {
      type: "auto_select",
      evaluation: "all_matches",
      rules: $rules,
      fallback: "jury",
      on_gate_error: "jury"
    }
  ' "$config" | tee "$updated" >/dev/null
  mv "$updated" "$config"
}

printf '%s\n' '1/14 gates command e jq aprovam sem juri'
CASE_DIR="$TEST_TMP/deterministic"
GATES="$(jq -cn --arg fake "$FAKE_CLI" '[
  {type:"command",argv:[$fake,"gate-pass"],timeout_seconds:2},
  {type:"jq",source:"output",filter:".status == \"ok\""}
]')"
make_config "$CASE_DIR" "deterministic" "worker-pass" '["deterministic"]' "layered" 1 0 "$GATES" 2
run_auto "$CASE_DIR/config.json" "deterministic" "layered" >/dev/null || fail "gate deterministico deveria aprovar"
[[ ! -e "$CASE_DIR/jury.called" ]] || fail "juri foi chamado apesar do gate aprovado"
assert_jq '
  any(.[]; .event == "run_started") and
  any(.[]; .event == "worker_finished" and .route == "deterministic") and
  any(.[]; .event == "gate_finished") and
  any(.[]; .event == "verification_finished") and
  any(.[]; .event == "run_finished")
' "$CASE_DIR/logs/auto.jsonl" "JSONL nao contem o ciclo completo"

printf '%s\n' '2/14 reprovação objetiva corrige no mesmo modelo uma vez'
CASE_DIR="$TEST_TMP/verifier-retry"
GATE_MARKER="$CASE_DIR/gate.failed-once"
GATES="$(jq -cn --arg fake "$FAKE_CLI" --arg marker "$GATE_MARKER" '[
  {type:"command",argv:[$fake,"gate-flaky",$marker],timeout_seconds:2}
]')"
make_config "$CASE_DIR" "verifier-retry" "worker-pass" '["verifier-retry"]' "layered" 2 1 "$GATES" 2
run_auto "$CASE_DIR/config.json" "verifier-retry" "layered" >/dev/null || fail "segunda tentativa deveria corrigir a reprovação"
assert_jq '[.[] | select(.event == "worker_finished") | .route] == ["verifier-retry", "verifier-retry"]' \
  "$CASE_DIR/logs/auto.jsonl" "reprovação não reamostrou o mesmo modelo"

printf '%s\n' '3/14 juri cego usa maioria preguicosa'
CASE_DIR="$TEST_TMP/jury"
make_config "$CASE_DIR" "secret-worker-model" "worker-pass" '["secret-worker-model"]' "layered" 1 0 '[]' 2
run_auto "$CASE_DIR/config.json" "secret-worker-model" "layered" >/dev/null || fail "juri deveria aprovar por dois votos"
[[ -e "$CASE_DIR/jury.called" ]] || fail "juri nao foi chamado"
[[ ! -e "$CASE_DIR/third.called" ]] || fail "terceiro juiz foi chamado sem necessidade"
assert_jq '[.[] | select(.event == "judge_finished")] | length == 2' \
  "$CASE_DIR/logs/auto.jsonl" "maioria preguicosa nao encerrou apos dois votos"

printf '%s\n' '4/14 divergencia chama o terceiro juiz cego'
CASE_DIR="$TEST_TMP/third-judge"
make_config "$CASE_DIR" "third-worker" "worker-pass" '["third-worker"]' "layered" 1 0 '[]' 2 \
  "judge-fail" "judge-pass" "judge-third"
run_auto "$CASE_DIR/config.json" "third-worker" "layered" >/dev/null || fail "terceiro juiz deveria formar maioria de aprovacao"
[[ -e "$CASE_DIR/third.called" ]] || fail "terceiro juiz nao foi chamado na divergencia"
assert_jq '[.[] | select(.event == "judge_finished" and .kind == "judge")] | length == 3' \
  "$CASE_DIR/logs/auto.jsonl" "divergencia nao produziu tres votos"

printf '%s\n' '5/14 falta de quorum chama o arbitro'
CASE_DIR="$TEST_TMP/arbiter"
make_config "$CASE_DIR" "arbiter-worker" "worker-pass" '["arbiter-worker"]' "layered" 1 0 '[]' 2 \
  "judge-pass" "judge-fail" "judge-third-abstain"
run_auto "$CASE_DIR/config.json" "arbiter-worker" "layered" >/dev/null || fail "arbitro deveria aprovar a tentativa"
assert_jq 'any(.[]; .event == "judge_finished" and .kind == "arbiter" and .verdict == "pass")' \
  "$CASE_DIR/logs/auto.jsonl" "arbitro nao foi chamado sem quorum"

printf '%s\n' '6/14 falha reamostra e escala conforme a ladder'
CASE_DIR="$TEST_TMP/escalation"
make_config "$CASE_DIR" "cheap-fail" "worker-fail" '["cheap-fail","expensive"]' "null" 3 1 '[]' 2
run_auto "$CASE_DIR/config.json" "cheap-fail" "null" >/dev/null || fail "rota escalada deveria concluir"
assert_jq '
  [.[] | select(.event == "worker_finished") | .route] ==
  ["cheap-fail", "cheap-fail", "expensive"]
' "$CASE_DIR/logs/auto.jsonl" "retry e escalada nao seguiram a configuracao"

printf '%s\n' '7/14 timeout e esgotamento retornam erro'
CASE_DIR="$TEST_TMP/timeout"
make_config "$CASE_DIR" "sleepy" "worker-timeout" '["sleepy"]' "null" 1 0 '[]' 1
set +e
run_auto "$CASE_DIR/config.json" "sleepy" "null" >/dev/null 2>&1
STATUS=$?
set -e
[[ "$STATUS" -ne 0 ]] || fail "timeout esgotado deveria retornar status nao-zero"
assert_jq '
  any(.[]; .event == "worker_finished" and .route == "sleepy" and .status == "timeout") and
  any(.[]; .event == "run_finished")
' "$CASE_DIR/logs/auto.jsonl" "timeout nao foi registrado no JSONL"

printf '%s\n' '8/14 formato codex_last_message usa o arquivo final'
CASE_DIR="$TEST_TMP/codex-output"
make_config "$CASE_DIR" "codex-output" "worker-pass" '["codex-output"]' "null" 1 0 '[]' 2
jq '
  (.routes[] | select(.name == "codex-output") | .headless.worker.argv) =
    [(.routes[] | select(.name == "codex-output") | .headless.worker.argv[0]), "worker-codex", "{output_file}"] |
  (.routes[] | select(.name == "codex-output") | .headless.worker.output_format) = "codex_last_message"
' "$CASE_DIR/config.json" | tee "$CASE_DIR/codex-config.json" >/dev/null
CODEX_OUTPUT="$(run_auto "$CASE_DIR/codex-config.json" "codex-output" "null")" || fail "codex_last_message deveria aprovar"
[[ "$CODEX_OUTPUT" == *'"source":"codex-file"'* ]] || fail "runner nao leu a ultima mensagem do arquivo Codex"

printf '%s\n' '9/14 verificador nulo aprova sem juri'
CASE_DIR="$TEST_TMP/null"
make_config "$CASE_DIR" "null-worker" "worker-pass" '["null-worker"]' "null" 1 0 '[]' 2
run_auto "$CASE_DIR/config.json" "null-worker" "null" >/dev/null || fail "verificador nulo deveria aprovar"
[[ ! -e "$CASE_DIR/jury.called" ]] || fail "juri foi chamado pelo verificador nulo"
assert_jq '
  any(.[]; .event == "worker_finished" and .route == "null-worker") and
  any(.[]; .event == "verification_finished") and
  any(.[]; .event == "run_finished")
' "$CASE_DIR/logs/auto.jsonl" "resultado do verificador nulo nao foi registrado"

printf '%s\n' '10/14 route preserva dry-run e --run e despacha --auto'
FAKE_BIN="$TEST_TMP/fake-bin"
mkdir -p "$FAKE_BIN"
tee "$FAKE_BIN/curl" >/dev/null <<'FAKE_CURL'
#!/usr/bin/env bash
printf '%s\n' '{"message":{"content":"{\"route\":[\"glm\"]}"}}'
FAKE_CURL
tee "$FAKE_BIN/open" >/dev/null <<'FAKE_OPEN'
#!/usr/bin/env bash
[[ -z "${OPEN_MARKER:-}" ]] || touch "$OPEN_MARKER"
printf 'fake-open:%s\n' "$*"
FAKE_OPEN
tee "$FAKE_BIN/uv" >/dev/null <<'FAKE_UV'
#!/usr/bin/env bash
printf 'fake-uv:%s\n' "$*"
FAKE_UV
chmod +x "$FAKE_BIN/curl" "$FAKE_BIN/open" "$FAKE_BIN/uv"

DRY_MARKER="$TEST_TMP/dry.opened"
DRY_OUTPUT="$(OPEN_MARKER="$DRY_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_DIR/route" "smoke route")"
[[ "$DRY_OUTPUT" == *"rota:     glm  ->  glm"* ]] || fail "dry-run nao preservou a rota"
[[ "$DRY_OUTPUT" == *"(dry-run; use --run para abrir a CLI)"* ]] || fail "dry-run nao preservou a mensagem"
[[ ! -e "$DRY_MARKER" ]] || fail "dry-run tentou abrir o Ghostty"

RUN_MARKER="$TEST_TMP/run.opened"
RUN_OUTPUT="$(OPEN_MARKER="$RUN_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_DIR/route" --run "smoke route")"
[[ -e "$RUN_MARKER" ]] || fail "--run nao chamou open"
[[ "$RUN_OUTPUT" == *"abrindo glm no Ghostty"* ]] || fail "--run nao preservou o fluxo interativo"

AUTO_MARKER="$TEST_TMP/auto.opened"
AUTO_OUTPUT="$(OPEN_MARKER="$AUTO_MARKER" PATH="$FAKE_BIN:$PATH" "$REPO_DIR/route" --auto --verifier null "smoke route")"
[[ "$AUTO_OUTPUT" == *"fake-uv:run --no-project --no-python-downloads python"* ]] || fail "--auto nao chamou o runner pelo uv"
[[ "$AUTO_OUTPUT" == *"--route glm"* ]] || fail "--auto nao repassou a rota escolhida"
[[ "$AUTO_OUTPUT" == *"--verifier null"* ]] || fail "--auto nao repassou o verificador"
[[ ! -e "$AUTO_MARKER" ]] || fail "--auto tentou abrir o Ghostty"

printf '%s\n' '11/14 seletor automatico aplica gate compativel sem juri'
CASE_DIR="$TEST_TMP/auto-select"
PROJECT_DIR="$CASE_DIR/project"
AUTO_GATE_MARKER="$CASE_DIR/gate.called"
mkdir -p "$PROJECT_DIR"
git -C "$PROJECT_DIR" init -q
touch "$PROJECT_DIR/project.marker" "$PROJECT_DIR/source.auto"
printf '%s\n' '{"scripts":{"test":"smoke"}}' | tee "$PROJECT_DIR/project.json" >/dev/null
make_config "$CASE_DIR" "auto-worker" "worker-write-auto" '["auto-worker"]' "layered" 1 0 '[]' 2
AUTO_RULES="$(jq -cn --arg fake "$FAKE_CLI" --arg marker "$AUTO_GATE_MARKER" '[
  {
    name: "automatic-gate",
    match: {
      files_all: ["project.marker"],
      changed_any: ["*.auto"],
      commands_all: ["bash"],
      json_keys_all: [{path: "project.json", keys: ["scripts.test"]}]
    },
    gates: [
      {type: "command", argv: [$fake, "gate-mark", $marker], timeout_seconds: 2}
    ]
  }
]')"
enable_auto_select "$CASE_DIR/config.json" "$AUTO_RULES"
run_auto "$CASE_DIR/config.json" "auto-worker" "" "$PROJECT_DIR" >/dev/null || \
  fail "seletor automatico deveria aprovar pelo gate"
[[ -e "$AUTO_GATE_MARKER" ]] || fail "gate automatico nao foi executado"
[[ ! -e "$CASE_DIR/jury.called" ]] || fail "juri foi chamado apesar do gate automatico"
assert_jq '
  any(.[]; .event == "verifier_selected" and
    .selected_rules == ["automatic-gate"] and .gate_count == 1 and .fallback == false)
' "$CASE_DIR/logs/auto.jsonl" "log nao registrou a selecao automatica"

printf '%s\n' '12/14 seletor automatico combina regras de multiplas stacks'
CASE_DIR="$TEST_TMP/auto-multi"
PROJECT_DIR="$CASE_DIR/project"
FIRST_GATE_MARKER="$CASE_DIR/first.called"
SECOND_GATE_MARKER="$CASE_DIR/second.called"
mkdir -p "$PROJECT_DIR"
git -C "$PROJECT_DIR" init -q
touch "$PROJECT_DIR/project.marker" "$PROJECT_DIR/source.auto"
make_config "$CASE_DIR" "multi-worker" "worker-write-auto" '["multi-worker"]' "layered" 1 0 '[]' 2
AUTO_RULES="$(jq -cn \
  --arg fake "$FAKE_CLI" \
  --arg first "$FIRST_GATE_MARKER" \
  --arg second "$SECOND_GATE_MARKER" '[
    {
      name: "first-stack",
      match: {files_all: ["project.marker"], changed_any: ["*.auto"]},
      gates: [{type: "command", argv: [$fake, "gate-mark", $first], timeout_seconds: 2}]
    },
    {
      name: "second-stack",
      match: {files_all: ["project.marker"], changed_any: ["*.auto"]},
      gates: [{type: "command", argv: [$fake, "gate-mark", $second], timeout_seconds: 2}]
    }
  ]')"
enable_auto_select "$CASE_DIR/config.json" "$AUTO_RULES"
run_auto "$CASE_DIR/config.json" "multi-worker" "" "$PROJECT_DIR" >/dev/null || \
  fail "multiplas regras automaticas deveriam aprovar"
[[ -e "$FIRST_GATE_MARKER" && -e "$SECOND_GATE_MARKER" ]] || \
  fail "seletor automatico nao executou todos os gates aplicaveis"
assert_jq '[.[] | select(.event == "gate_finished")] | length == 2' \
  "$CASE_DIR/logs/auto.jsonl" "multiplas regras nao produziram dois gates"

printf '%s\n' '13/14 alteracao suja anterior ao worker nao seleciona gate'
CASE_DIR="$TEST_TMP/auto-fallback"
PROJECT_DIR="$CASE_DIR/project"
mkdir -p "$PROJECT_DIR"
git -C "$PROJECT_DIR" init -q
touch "$PROJECT_DIR/project.marker" "$PROJECT_DIR/source.auto"
make_config "$CASE_DIR" "fallback-worker" "worker-pass" '["fallback-worker"]' "layered" 1 0 '[]' 2
AUTO_RULES='[
  {
    "name": "missing-code-gate",
    "match": {"files_all": ["project.marker"], "changed_any": ["*.auto"]},
    "gates": [{"type": "command", "argv": ["true"], "timeout_seconds": 2}]
  }
]'
enable_auto_select "$CASE_DIR/config.json" "$AUTO_RULES"
run_auto "$CASE_DIR/config.json" "fallback-worker" "" "$PROJECT_DIR" >/dev/null || \
  fail "alteracao preexistente deveria usar o juri como fallback"
[[ -e "$CASE_DIR/jury.called" ]] || fail "juri nao foi chamado no fallback automatico"
assert_jq '
  any(.[]; .event == "verifier_selected" and
    .selected_rules == [] and .gate_count == 0 and .fallback == true)
' "$CASE_DIR/logs/auto.jsonl" "fallback automatico nao foi registrado"

printf '%s\n' '14/14 regra pnpm real seleciona teste pelo delta do worker'
CASE_DIR="$TEST_TMP/real-pnpm-rule"
PROJECT_DIR="$CASE_DIR/project"
REAL_RULE_BIN="$CASE_DIR/bin"
REAL_GATE_MARKER="$CASE_DIR/pnpm.called"
mkdir -p "$PROJECT_DIR/node_modules" "$REAL_RULE_BIN"
git -C "$PROJECT_DIR" init -q
printf '%s\n' '{"scripts":{"test":"fake"}}' | tee "$PROJECT_DIR/package.json" >/dev/null
touch "$PROJECT_DIR/pnpm-lock.yaml" "$PROJECT_DIR/source.ts"
tee "$REAL_RULE_BIN/pnpm" >/dev/null <<'FAKE_PNPM'
#!/usr/bin/env bash
set -euo pipefail
touch "${REAL_GATE_MARKER:?}"
FAKE_PNPM
chmod +x "$REAL_RULE_BIN/pnpm"
make_config "$CASE_DIR" "real-rule-worker" "worker-write-ts" '["real-rule-worker"]' "layered" 1 0 '[]' 2
REAL_RULES="$(jq -c '.auto.verifiers.auto_select.rules' "$REPO_DIR/config.json")"
enable_auto_select "$CASE_DIR/config.json" "$REAL_RULES"
PATH="$REAL_RULE_BIN:$PATH" REAL_GATE_MARKER="$REAL_GATE_MARKER" \
  run_auto "$CASE_DIR/config.json" "real-rule-worker" "" "$PROJECT_DIR" >/dev/null || \
  fail "regra pnpm real deveria executar o teste automatico"
[[ -e "$REAL_GATE_MARKER" ]] || fail "regra pnpm real nao executou o gate"
assert_jq '
  any(.[]; .event == "verifier_selected" and
    .selected_rules == ["pnpm-tests"] and .gate_count == 1 and .fallback == false)
' "$CASE_DIR/logs/auto.jsonl" "regra pnpm real nao foi selecionada sozinha"

printf '%s\n' 'smoke: OK'
