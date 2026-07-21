# llm-router

Roteador local de modelos. Dado um prompt, um classificador local
(Plano-Orchestrator-4B, baseado no Qwen3-4B e executado pelo Ollama) escolhe a
rota inicial entre Claude, Codex, MiniMax e GLM.

O comando tem três modos de execução e um help:

| Modo | Comportamento |
|------|---------------|
| padrão | Dry-run: mostra a rota escolhida e encerra |
| `--run` | Abre a CLI interativa em uma janela do Ghostty |
| `--auto` | Executa a tarefa em modo headless, verifica o resultado e escala quando necessário |
| `help` ou `--help` | Mostra modos, rotas, cascade, verificadores, exemplos e requisitos |

O dry-run e o `--run` mantêm o comportamento original. O cascade só é iniciado
quando `--auto` é informado.

## Uso

```bash
route "otimiza essa query lenta"
route --run "otimiza essa query lenta"
route --auto "corrija o bug e valide a alteração"
route --help
```

No modo padrão, o comando apenas mostra a decisão. Com `--run`, ele carrega o
alias correspondente do `~/.zshrc` e abre o Ghostty para uma sessão interativa.

Com `--auto`, o `route` chama `auto_runner.py` pelo `uv`, no diretório em que o
comando foi executado. Nenhuma janela é aberta e não há aprovação humana entre
as tentativas. O perfil padrão `auto_select` escolhe sozinho entre gates
determinísticos e o júri. `--verifier` existe como override avançado para
diagnóstico ou para desabilitar o gate com `null`.

## Como o roteamento funciona

O `route` envia ao Plano as intenções semânticas de `routing`, chama o endpoint
`/api/chat` do Ollama com `think:false` e restringe a resposta por JSON Schema a
exatamente uma intenção configurada. Depois, mapeia essa intenção ao executor
real. Uma resposta vazia ou inválida encerra com erro, sem escolher um modelo por
fallback.

Mapeamento atual:

| Intenção | Rota | Alias | Executor | Uso principal |
|----------|------|-------|----------|---------------|
| `literal_read_only_no_writing` | `minimax` | `m3` | MiniMax M3 | Contagem, listagem, busca, extração e formatação literais, sempre sem mutação |
| `translation_simple_brainstorm_docs_or_intermediate_work` | `glm` | `glm` | GLM 5.2 | Tradução e trabalho simples ou intermediário com escopo claro |
| `complex_creative_product_or_architecture` | `claude` | `cld` | Claude Opus 4.8 com `xhigh` | Arquitetura, estratégia, produto e escrita criativa complexa sem implementação |
| `review_security_hard_engineering_or_technical_writing` | `codex` | `cdx` | GPT 5.6 Sol com `xhigh` | Engenharia difícil, texto técnico preciso, auditoria e code review |

Os nomes das intenções descrevem a tarefa, não o fornecedor. Isso reduz a
sobreposição semântica para o Plano-Orchestrator. Em pedidos mistos, a entrega
final decide a rota: tradução pura vai para GLM; tradução combinada com
planejamento complexo segue para Claude; code review e auditoria seguem para
Codex.

Para as categorias medidas no benchmark V2, a política usa esta matriz:

| Categoria | Simples | Intermediária | Difícil |
| --- | --- | --- | --- |
| Discussão aberta | GLM | Claude | Claude |
| Brainstorm | GLM | Claude | Claude |
| Ideias de produto | Claude | Claude | Claude |
| Arquitetura | Claude | Claude | Claude |
| PR review | Codex | Codex | Codex |
| Texto técnico | Codex | Codex | Codex |
| Documentação | GLM | GLM | Codex |
| Rede social | GLM | Codex técnico, GLM geral | Claude |
| Resolução de bugs | GLM | GLM | Codex |
| Refatoração | GLM | GLM | Codex |
| Escrita de testes | GLM | GLM | Codex |
| Sales copy | GLM | Claude | Claude |

MiniMax fica fora dessas 12 categorias porque até os casos simples exigem
interpretação ou produção autoral. Ele continua sendo a rota econômica para
operações literais de baixo risco. Tradução pura tem piso GLM; tradução com
arquitetura vai para Claude; tradução com implementação difícil, review,
auditoria ou segurança vai para Codex. O classificador usa a dificuldade e a
consequência da tarefa, não o tamanho do prompt.

Planejar a correção de uma race condition ou deadlock, sem executar diagnóstico
nem implementar, vai para Claude. Implementação, investigação executada,
threat model e análise de segurança vão para Codex.

A matriz combina três medidas separadas: qualidade textual em revisão cega,
conformidade determinística e confiabilidade do processo. A revisão cega é feita
por um juiz LLM anonimizado e serve como sinal suplementar. Os casos de
criatividade próximos continuam sujeitos a revisão humana, conforme detalhado
em `BENCHMARK.md`.

O worker MiniMax fica limitado a `Read,Glob,Grep`, sem Bash, edição, MCP externo
ou slash commands. Isso mantém a rota trivial adequada para inspeção e
transformação de resposta, sem permitir mudanças no projeto. Qualquer pedido que
edite arquivos começa no GLM ou em uma rota superior.

## Cascade automático

Depois da classificação inicial, `--auto` segue este fluxo:

1. Executa a rota escolhida como worker headless e captura stdout, stderr e
   exit code.
2. Detecta quais gates determinísticos se aplicam ao projeto e aos arquivos
   alterados.
3. Executa todos os gates selecionados. Sem gate aplicável, consulta o júri LLM.
4. Se a tentativa reprovar, envia a saída anterior e o feedback ao próximo
   worker. A política pode reamostrar uma vez na mesma rota antes de avançar na
   ladder.
5. Encerra ao obter aprovação ou atingir um teto de tentativas, sessões ou
   tempo.

A escalada reaproveita o resultado e as evidências da tentativa anterior. O
modelo seguinte recebe instruções de reparo para corrigir o trabalho existente
em vez de reiniciar a tarefa sem contexto. O runner não desfaz alterações do
workspace entre tentativas.

As ladders atuais são:

```text
minimax -> minimax -> glm   -> glm
glm     -> glm     -> codex -> codex
codex   -> codex   -> claude -> claude
claude  -> claude
```

A repetição da mesma rota é controlada por `auto.retry_same_route`. Na
configuração padrão, há no máximo uma repetição para `process_error`, `timeout`,
`fail` ou verificação inconclusiva. Isso permite uma correção no mesmo modelo
antes da escalada, inclusive quando um gate ou o júri reprova a tentativa.

## Execução headless

Cada rota declara comandos separados para worker e judge em
`routes[].headless`. Os judges têm timeout menor e trabalham sem ferramentas ou
com sandbox somente leitura. Os workers podem alterar o diretório da tarefa.

Os comandos configurados são equivalentes a:

```bash
# Claude worker
claude --print --output-format json --no-session-persistence \
  --append-system-prompt-file "${HOME}/.claude/system-prompt/append.md" \
  --dangerously-skip-permissions --model claude-opus-4-8 --effort xhigh

# MiniMax worker, com o ambiente ANTHROPIC_* definido em config.json
claude --print --output-format json --no-session-persistence \
  --append-system-prompt-file "${HOME}/.claude/system-prompt/append.md" \
  --permission-mode dontAsk --tools Read,Glob,Grep \
  --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disable-slash-commands --model MiniMax-M3

# GLM worker, com o ambiente ANTHROPIC_* definido em config.json
claude --print --output-format json --no-session-persistence \
  --append-system-prompt-file "${HOME}/.claude/system-prompt/append.md" \
  --dangerously-skip-permissions --model glm-5.2

# Codex worker; o prompt entra por stdin
codex --ask-for-approval never exec --json --ephemeral \
  --output-last-message "{output_file}" \
  --model gpt-5.6-sol \
  --config model_reasoning_effort=xhigh \
  --config features.apps=false \
  --sandbox workspace-write \
  --cd "{cwd}" -
```

O runner monta `argv` diretamente, sem interpolar o prompt em um shell. Os
placeholders `{cwd}`, `{project_root}` e `{output_file}` são preenchidos durante
a execução.
Variáveis sensíveis usam referências como `{"from_env":"MINIMAX_API_KEY"}`;
o valor não fica gravado no repositório.

## Verificação

### Seleção automática

`auto_select` é o verificador padrão. Antes da primeira tentativa, ele registra
o `HEAD` e o hash dos arquivos que já estavam sujos. Depois do worker, compara o
novo estado com esse baseline e avalia somente arquivos modificados durante a
execução. Alterações preexistentes não acionam gates. O delta é comparado com as
regras de `auto.verifiers.auto_select.rules`; o prompt não decide qual teste será
usado.

As regras incluídas são:

| Regra | Condições principais | Gate |
|-------|----------------------|------|
| `llm-router-smoke` | Arquivos deste roteador alterados | `bash tests/smoke.sh` |
| `pnpm-tests` | `package.json`, lockfile, `node_modules`, script `test` e JS/TS alterado | `pnpm test` |
| `python-pytest` | Config Python, `tests`, `.venv` e código ou configuração Python alterada | `uv run --no-sync pytest` |
| `rust-tests` | `Cargo.toml` e Rust alterado | `cargo test` |
| `go-tests` | `go.mod` e Go alterado | `go test ./...` |

Se duas stacks forem alteradas, os dois gates são executados. Se nenhuma regra
for aplicável, o runner chama o júri. Diretórios fora de um repositório Git
também seguem para o júri, pois não há diff confiável para selecionar testes.

O uso normal não exige escolher um verificador:

```bash
route --auto "corrija o bug e valide a alteração"
```

### Gates determinísticos

Há dois tipos de gate:

- `command`: executa `argv` no diretório da tarefa. Exit code `0` aprova, códigos
  listados em `error_exit_codes` indicam erro de infraestrutura e os demais
  reprovam. `timeout_seconds`, `cwd` e `env` são opcionais.
- `jq`: executa o `filter` sobre `source`, que pode ser o JSON de `output` ou o
  texto bruto de `evidence`. Exit code `0` aprova, `1` reprova e os demais
  indicam erro.

Todos os gates selecionados precisam passar. Uma reprovação objetiva encerra a
verificação daquela tentativa. Falha ao iniciar um processo, timeout ou exit
code listado em `error_exit_codes` segue `on_gate_error`, que aceita outro
verificador, `pass`, `fail` ou `inconclusive`. Na configuração atual, o júri
decide esses erros.

Novas stacks são adicionadas como regras, sem mudar o comando usado no dia a
dia. Exemplo reduzido:

```json
{
  "name": "ruby-tests",
  "match": {
    "files_all": ["Gemfile"],
    "changed_any": ["*.rb", "**/*.rb"],
    "commands_all": ["bundle"]
  },
  "gates": [
    {
      "type": "command",
      "argv": ["bundle", "exec", "rspec"],
      "cwd": "{project_root}",
      "timeout_seconds": 600
    }
  ]
}
```

### Júri cego

O perfil `jury` usa maioria preguiçosa com quórum de dois. Os thresholds atuais
são `0.85` para Codex e Claude, e `0.80` para GLM:

1. Codex e Claude julgam separadamente, sem saber qual worker produziu a saída
   e sem ver o voto um do outro.
2. Se os dois votos válidos concordarem, a decisão está formada e GLM não é
   chamado.
3. Em divergência ou abstenção, GLM emite o terceiro voto às cegas.
4. Sem quórum, o árbitro decide com threshold próprio. A configuração prefere
   Codex e evita usar a mesma rota do worker; Claude é o fallback.

Cada judge devolve `pass`, `fail` ou `abstain`, acompanhado de confiança,
falhas observadas e instruções de reparo. Um voto abaixo do `threshold` vira
abstenção. Em uma reprovação, o feedback do Codex é preferido quando ele
integra os votos de falha; caso contrário, o runner usa as falhas da maioria.

Sessões de judge e árbitro entram nos tetos de custo do modo automático.

### Verificador nulo

O perfil `null` sempre aprova a primeira execução que terminar com sucesso. Ele
é um escape explícito para diagnóstico ou para uma execução em que o usuário
queira assumir o risco de pular toda verificação:

```bash
route --auto --verifier null "gere cinco nomes para o projeto"
```

## Configuração

Toda a configuração fica em `config.json` ao lado do `route`.

Cada item de `routing` contém:

- `intent`, o rótulo semântico enviado ao Plano-Orchestrator;
- `route`, o executor associado à intenção;
- `description`, os limites e capacidades usados na classificação;
- `help`, a descrição curta exibida por `route --help`.

Cada item de `routes` contém:

- `name`, `cli` e `display_name`, usados na execução e no help;
- `headless.env`, com valores literais ou referências `from_env`;
- `headless.worker` e `headless.judge`, com `argv`, `output_format` e
  `timeout_seconds`.

Os formatos de saída aceitos são `text`, `claude_json` e
`codex_last_message`. O bloco `auto` contém:

| Chave | Função |
|-------|--------|
| `max_worker_attempts` | Teto de tentativas de worker |
| `max_judge_sessions` | Teto de sessões de judge e árbitro |
| `max_total_sessions` | Teto somado de workers e judges |
| `max_total_seconds` | Deadline global do cascade |
| `feedback_max_chars` | Limite do feedback repassado ao worker |
| `evidence_max_chars` | Limite de evidências entregues ao júri |
| `retry_same_route` | Quantidade e motivos de reamostragem |
| `ladders` | Ordem de escalada para cada rota inicial |
| `verifiers` | Seleção automática, gates, júri, `null` e perfis adicionais |
| `default_verifier` | Perfil usado quando `--verifier` não é informado |
| `log` | Caminho e política de conteúdo do JSONL |

Todos esses valores são configuráveis. Rotas, thresholds, ladders e tetos vêm
do `config.json`.

## Limites e erros

A configuração padrão permite quatro tentativas de worker, doze sessões de
judge, dezesseis sessões no total e 1.800 segundos por execução completa. Cada
worker tem timeout de 900 segundos e cada judge, 300 segundos.

Executável ausente, variável de ambiente obrigatória ausente, exit code
diferente de zero, timeout e saída inválida são tratados separadamente.
Processos são iniciados em grupo; quando o timeout expira, o runner encerra o
grupo. O exit code final é `0` para aprovação, `1` para reprovação, teto ou
deadline esgotado, e `2` para erro de uso ou configuração.

## Logs

O modo automático grava eventos JSONL em `logs/auto.jsonl`, caminho resolvido a
partir do diretório do `config.json`. A pasta `logs/` é criada na primeira
execução e está no `.gitignore`.

Os eventos são `run_started`, `route_selected`, `worker_finished`,
`verifier_selected`, `gate_finished`, `judge_finished`, `verification_finished`
e `run_finished`.
Eles registram rota, tentativas, durações, escaladas e resultado final. Hash e
tamanho do prompt e da saída são sempre gravados. O conteúdo integral só entra
no log quando `include_prompt` ou `include_output` está habilitado; ambos são
`false` por padrão.

## Segurança e permissões

`--auto` trabalha sem humano no loop. Na configuração atual, Claude e GLM usam
`--dangerously-skip-permissions`; MiniMax usa `--permission-mode dontAsk` e fica
limitado a `Read,Glob,Grep`; o worker Codex usa `workspace-write`. Judges não
recebem ferramentas no Claude Code, e o Codex judge usa sandbox `read-only`.

Antes de executar uma tarefa automática:

- use uma branch de trabalho e confira `git status`;
- trate comandos de gates como código confiável, pois eles são executados no
  diretório da tarefa;
- mantenha tokens somente nas variáveis `MINIMAX_API_KEY` e `ZAI_API_KEY`;
- revise o diff e o JSONL depois da execução;
- defina tetos menores para tarefas de alto risco.

O runner não faz rollback e não isola o workspace em um container.

## Por que o Plano-Orchestrator-4B

Escolhido por benchmark local (Mac mini M2 Pro, 192 prompts rotulados, mesma política nos
três modelos):

| Modelo                | Acurácia         | Latência mediana | RAM    |
|-----------------------|------------------|------------------|--------|
| Plano-Orchestrator-4B | 92,2% (177/192)  | ~843 ms          | 2,5 GB |
| Mellum2-12B-A2.5B     | 87,0% (167/192)  | ~862 ms          | 8,1 GB |
| Arch-Router-1.5B      | 80,2% (154/192)  | ~594 ms          | 1,0 GB |

O Plano venceu em acurácia com 3x menos RAM que o Mellum. Requer `think:false`
(o Qwen3 põe a resposta no campo `thinking` por padrão) e o formato nativo
`<routes>`. O JSON Schema exige uma lista com exatamente uma intenção:
`{"route": ["intent_name"]}`.

## Requisitos

- Ollama em execução.
- Modelo do classificador baixado:

  ```bash
  ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
  ```

- `jq` e `curl` disponíveis no PATH.
- `uv` com Python disponível para `--auto`.
- `trash` para limpar arquivos temporários de saída sem exclusão permanente.
- CLIs `claude` e `codex` autenticadas para `--auto`.
- `MINIMAX_API_KEY` e `ZAI_API_KEY` definidas para usar essas rotas headless.
- Ghostty e os aliases `cld`, `cdx`, `m3` e `glm` no `~/.zshrc` para `--run`.

Ghostty e os aliases são usados somente por `--run`.

## Instalação

O repositório vive em `~/www/ai/llm-router`. Exponha o `route` no PATH:

```bash
export PATH="$HOME/www/ai/llm-router:$PATH"
```

## Testes

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
uv run --no-project --no-python-downloads python -m unittest tests/test_quality_eval.py
uv run --no-project --no-python-downloads python quality_eval.py --help
```

O smoke usa executores falsos e uma configuração temporária. Ele valida o
cascade sem chamar Ollama, Claude, Codex, MiniMax ou GLM e sem consumir
créditos. O `routing-eval.sh` chama somente o classificador local no Ollama e
exige 100% de acerto na matriz de regressão. Essa matriz valida a
política do projeto; ela não substitui um benchmark independente dos modelos.

O `quality_eval.py` mede qualidade de resposta com workspaces isolados, auditoria
determinística e relatórios JSON e Markdown. `tests/quality-cases.json` preserva
o piloto V1 de seis casos, quatro rotas e três repetições. A matriz V2 em
`tests/quality-cases-v2.json` cobre 36 casos, 12 categorias e três dificuldades.
Ela aceita seleção adaptativa por caso, checkpoint, retomada e execução
concorrente. Antes de consumir créditos, valide o dataset e os executores:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config config.json \
  --cases tests/quality-cases.json \
  --output /tmp/llm-router-quality.json \
  --validate-only
```

Remova `--validate-only` para executar as chamadas. Use `--replay-report` para
reaplicar rubricas corrigidas às saídas já registradas, sem chamar os modelos de
novo. `--selection` limita rotas por caso e `--parallel` controla a concorrência.
Na rodada adaptativa local, `--parallel 30` terminou 132 chamadas físicas em 9
minutos e 9 segundos, com ganho efetivo de 21,07 vezes sobre a soma das durações.
Esse número descreve esta máquina e estes provedores. O benchmark avalia os
executores configurados e não representa uma classificação geral dos modelos
base.
