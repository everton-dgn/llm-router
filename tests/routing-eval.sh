#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUTE_COMMAND="${LLM_ROUTER_ROUTE:-$REPO_DIR/route}"
MIN_ACCURACY="${ROUTING_EVAL_MIN_ACCURACY:-95}"

[[ -x "$ROUTE_COMMAND" ]] || {
  printf 'erro: route nao executavel em %s\n' "$ROUTE_COMMAND" >&2
  exit 2
}
if [[ ! "$MIN_ACCURACY" =~ ^[0-9]+$ ]] || (( MIN_ACCURACY < 0 || MIN_ACCURACY > 100 )); then
  printf 'erro: ROUTING_EVAL_MIN_ACCURACY precisa estar entre 0 e 100\n' >&2
  exit 2
fi

cases=(
  'minimax|qual versao do React este projeto usa?'
  'minimax|conte quantos TODO existem em src'
  'minimax|formate este JSON com indentacao de dois espacos'
  'minimax|traduza esta mensagem de erro para portugues'
  'minimax|liste os arquivos modificados no git'
  'minimax|resuma estas vinte linhas de log em uma frase'
  'minimax|extraia os nomes dos endpoints deste arquivo'
  'minimax|gere cinco nomes curtos para esta branch'
  'minimax|corrija um erro de digitacao neste comentario'
  'minimax|what does this shell flag mean?'
  'glm|adicione testes unitarios para esta funcao existente'
  'glm|corrija os erros de lint deste componente'
  'glm|implemente paginacao neste endpoint existente'
  'glm|adicione cache a este service seguindo o padrao atual'
  'glm|descubra por que este controller retorna 500'
  'glm|crie uma migration para uma nova coluna nullable'
  'glm|adicione estado de loading e teste ao formulario'
  'glm|investigue por que este job de CI falha'
  'glm|escreva um script para importar este CSV'
  'glm|explique o fluxo de autenticacao deste modulo'
  'claude|desenhe a estrategia de autenticacao para um SaaS multi-tenant'
  'claude|planeje uma migration de banco sem downtime'
  'claude|escreva um ADR comparando eventos e chamadas sincronas'
  'claude|proponha a arquitetura de sincronizacao offline deste aplicativo'
  'claude|decomponha esta iniciativa de seis meses em fases e dependencias'
  'claude|analise os riscos e planeje a troca do provedor de pagamentos'
  'claude|defina a estrategia de capacidade para suportar dez vezes mais trafego'
  'claude|crie um threat model para a nova arquitetura'
  'claude|planeje como corrigir a race condition sem alterar codigo ainda'
  'claude|which architecture should we adopt for a critical multi-region system?'
  'codex|revise este PR de pagamentos procurando idempotencia e concorrencia'
  'codex|audite o codigo de login e encontre falhas de seguranca'
  'codex|implemente uma fila lock-free com testes de stress'
  'codex|corrija o deadlock entre estes workers'
  'codex|encontre a causa deste memory leak intermitente e corrija'
  'codex|refatore o gerenciamento de estado compartilhado em todo o app'
  'codex|implemente esta transformacao de compilador e valide os casos extremos'
  'codex|faca code review desta funcao e reporte problemas com linha'
  'codex|implemente a mudanca dificil, comecando por um plano e terminando com testes'
  'codex|planeje e implemente a migracao completa destes tres modulos'
)

correct=0
total=0

for row in "${cases[@]}"; do
  expected="${row%%|*}"
  prompt="${row#*|}"
  output="$($ROUTE_COMMAND "$prompt" 2>&1)" || {
    printf 'ERRO esperado=%-7s obtido=falha   %s\n' "$expected" "$prompt"
    total=$((total + 1))
    continue
  }
  selected="$(awk '/^rota:/ {print $2}' <<<"$output")"
  total=$((total + 1))
  if [[ "$selected" == "$expected" ]]; then
    correct=$((correct + 1))
  else
    printf 'ERRO esperado=%-7s obtido=%-7s %s\n' "$expected" "${selected:-vazio}" "$prompt"
  fi
done

accuracy=$((100 * correct / total))
printf 'roteamento: %d/%d (%d%%), minimo=%d%%\n' "$correct" "$total" "$accuracy" "$MIN_ACCURACY"
(( accuracy >= MIN_ACCURACY )) || exit 1
