#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROUTE_COMMAND="${LLM_ROUTER_ROUTE:-$REPO_DIR/route}"
MIN_ACCURACY="${ROUTING_EVAL_MIN_ACCURACY:-100}"

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
  'minimax|liste os arquivos modificados no git'
  'glm|resuma estas vinte linhas de log em uma frase'
  'minimax|extraia os nomes dos endpoints deste arquivo'
  'glm|gere cinco nomes curtos para esta branch'
  'glm|corrija um erro de digitacao neste comentario'
  'minimax|what does this shell flag mean?'
  'glm|discuta brevemente os pros e contras de trocar a daily por um update escrito'
  'glm|brainstorm five onboarding exercises for a small documentation team'
  'glm|escreva a referencia simples deste comando CLI a partir das flags fornecidas'
  'glm|crie um troubleshooting guide para este fluxo de login conhecido'
  'glm|escreva um post curto de release para desenvolvedores com estes fatos'
  'glm|escreva uma hero section simples para este produto sem inventar metricas'
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
  'glm|traduza esta mensagem de erro para portugues'
  'claude|desenhe a estrategia de autenticacao para um SaaS multi-tenant'
  'claude|planeje uma migration de banco sem downtime'
  'claude|escreva um ADR comparando eventos e chamadas sincronas'
  'claude|proponha a arquitetura de sincronizacao offline deste aplicativo'
  'claude|decomponha esta iniciativa de seis meses em fases e dependencias'
  'claude|analise os riscos e planeje a troca do provedor de pagamentos'
  'claude|defina a estrategia de capacidade para suportar dez vezes mais trafego'
  'codex|crie um threat model para a nova arquitetura'
  'claude|planeje como corrigir a race condition sem alterar codigo ainda'
  'claude|which architecture should we adopt for a critical multi-region system?'
  'claude|traduza este ADR e proponha a estrategia de migracao sem alterar codigo'
  'claude|discuta build versus buy para esta plataforma e apresente os trade-offs sem implementar'
  'claude|conduza um brainstorm aprofundado para o lancamento deste produto de privacidade'
  'claude|gere ideias de produto para tradutores freelancers e avalie viabilidade'
  'claude|proponha novos produtos para operacoes juridicas com riscos e validacao'
  'claude|escreva uma campanha de vendas complexa para uma migracao enterprise'
  'claude|adapte este estudo para uma campanha tecnica em tres redes sociais'
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
  'codex|traduza e audite este codigo de autenticacao procurando falhas de seguranca'
  'codex|explique idempotencia em um texto tecnico curto e preciso para engenheiros'
  'codex|escreva um design memo tecnico comparando estas garantias de entrega'
  'codex|escreva a analise tecnica detalhada deste incidente com invariantes e evidencias'
  'codex|documente a migracao dificil desta API v2 com compatibilidade e rollback'
  'codex|escreva uma thread tecnica intermediaria sobre este incidente sem inventar fatos'
  'codex|adicione testes de concorrencia para garantir execucao exatamente uma vez'
)

correct=0
total=0

for row in "${cases[@]}"; do
  expected="${row%%|*}"
  prompt="${row#*|}"
  output="$($ROUTE_COMMAND --classify --json "$prompt" 2>&1)" || {
    printf 'ERRO esperado=%-7s obtido=falha   %s\n' "$expected" "$prompt"
    total=$((total + 1))
    continue
  }
  if ! jq -e '
    .schema_version == 1 and
    (.intent | type == "string" and length > 0) and
    (.route | IN("minimax", "glm", "claude", "codex")) and
    (keys | sort == ["intent", "route", "schema_version"])
  ' <<<"$output" >/dev/null; then
    printf 'ERRO esperado=%-7s obtido=contrato-invalido %s\n' "$expected" "$prompt"
    total=$((total + 1))
    continue
  fi
  selected="$(jq -r '.route' <<<"$output")"
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
