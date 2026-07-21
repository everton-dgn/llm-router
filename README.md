# llm-router

Roteador local de tarefas entre MiniMax M3, GLM 5.2, Claude Opus 4.8 e GPT-5.6 Sol. O classificador local escolhe uma rota sem executar o modelo. A execução e a coordenação ficam no OpenCode.

## Arquitetura

| Componente | Responsabilidade |
| --- | --- |
| `route` | Classifica um pedido e devolve uma rota para uma pessoa ou para uma integração JSON |
| `config.json` | Define as intenções, as quatro rotas e as regras de verificação determinística |
| `opencode/opencode.jsonc` | Configura o agente `router`, os subagentes e os providers do OpenCode |
| `opencode/tools/llm_route.ts` | Chama `route --classify --json`, valida o contrato e aplica os pisos de segurança |
| `opencode/tools/claude_agent.ts` | Usa o Claude Agent SDK em modo read-only para planejamento e raciocínio criativo |
| `opencode/tools/repo_query.ts` | Dá aos agentes read-only consultas fixas e seguras sobre o worktree |
| `opencode/plugins/llm_router_prompt_guard.ts` | Preserva o pedido original até a classificação da etapa |
| `stage_verifier.py` | Registra o baseline, calcula o delta exato e executa gates determinísticos |
| `benchmark_executor.py` | Executa modelos single-shot somente no benchmark offline |

O fluxo de produção é:

```text
pedido
  -> router do OpenCode
  -> llm_route
  -> task nativa ou claude_agent
  -> stage_prepare e stage_verify quando houver mutação
  -> resposta ou correção baseada nas evidências
```

## Classificador local

O `route` tem duas saídas. A saída humana mostra a decisão de forma legível:

```bash
./route "otimiza essa query lenta"
```

```text
rota: codex -> GPT-5.6 Sol (xhigh)
```

A saída de integração usa um contrato JSON estável:

```bash
./route --classify --json "traduza este parágrafo para inglês"
```

```json
{"schema_version":1,"intent":"translation_simple_brainstorm_docs_or_intermediate_work","route":"glm"}
```

Erros do modo JSON também têm `schema_version` e um objeto `error` com `code` e `message`. Consulte os argumentos aceitos com:

```bash
./route --help
```

O comando encerra depois da classificação. Toda execução de modelo acontece no OpenCode ou no benchmark offline.

O classificador envia ao Ollama as intenções semânticas de `routing`, usa o endpoint `/api/chat` com `think:false` e restringe a resposta com JSON Schema. Resposta vazia, rota desconhecida ou JSON inválido termina com erro, sem fallback silencioso.

## Matriz de rotas

| Intenção | Rota | Destino de produção | Uso principal |
| --- | --- | --- | --- |
| `literal_read_only_no_writing` | `minimax` | subagente nativo `minimax` | Contagem, listagem, busca, extração e formatação literais sem mutação |
| `translation_simple_brainstorm_docs_or_intermediate_work` | `glm` | subagente nativo `glm` | Tradução e trabalho simples ou intermediário com escopo claro |
| `complex_creative_product_or_architecture` | `claude` | ferramenta `claude_agent` | Arquitetura, produto, estratégia e escrita criativa complexa sem implementação |
| `review_security_hard_engineering_or_technical_writing` | `codex` | subagente nativo `codex` | Engenharia difícil, texto técnico, auditoria, segurança e revisão |

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

MiniMax recebe somente operações literais de baixo risco. Qualquer mutação tem piso GLM. Tradução pura também tem piso GLM. Arquitetura ou planejamento complexo elevam para Claude. Revisão, auditoria, segurança, texto técnico de precisão e implementação difícil elevam para Codex.

Planejamento de uma correção difícil, sem diagnóstico executado nem implementação, usa Claude. A investigação executada e a implementação usam Codex quando o trabalho entra no nível difícil.

O effort do Claude é dinâmico:

| Tipo de tarefa | Effort |
| --- | --- |
| Planejamento, arquitetura, produto, ideação, copy e criação | `max` |
| Discussão aberta, debate, trade-offs, política e falsificação | `xhigh` |
| Demais casos aceitos pelo Claude | `max` |

Essa decisão vem da comparação cega registrada em [BENCHMARK.md](BENCHMARK.md).

## Orquestração no OpenCode

O agente primário `router` usa GPT-5.6 Sol com `reasoningEffort: xhigh` e `textVerbosity: medium`. Para cada etapa, ele chama `llm_route` somente com `stage` e delega de acordo com o contrato retornado. O plugin `llm_router_prompt_guard.ts` captura o texto da mensagem do usuário em memória por sessão, e `llm_route` lê esse texto diretamente pelo `sessionID` da chamada. Assim, a UI mostra apenas `stage`, enquanto aspas, paráfrases ou contexto acrescentado pelo agente não chegam ao classificador. O texto capturado é removido quando a sessão fica ociosa ou é apagada.

### Subagentes nativos

| Subagente | Modelo | Papel | Permissão principal |
| --- | --- | --- | --- |
| `minimax` | `minimax-coding-plan/MiniMax-M3` | Leitura literal e respostas mecânicas | Somente `repo_query`, sem Bash ou ferramentas de escrita |
| `glm` | `zai-coding-plan/glm-5.2` | Trabalho simples ou intermediário | Pode executar e editar dentro das permissões do OpenCode |
| `codex` | `openai/gpt-5.6-sol` | Engenharia difícil e execução complexa | Pode executar e editar dentro das permissões do OpenCode |
| `codex-reviewer` | `openai/gpt-5.6-sol` | Revisão independente | Somente `repo_query`, sem Bash ou ferramentas de escrita |

Esses quatro destinos usam a ferramenta nativa `task` em primeiro plano. O `subagent_type` deve corresponder exatamente ao nome da tabela. As execuções criam sessões filhas navegáveis no OpenCode.

`repo_query` oferece ações fixas para status, arquivos versionados, leitura com linhas numeradas, busca literal, diff, log e maiores arquivos por linhas. A implementação usa argumentos separados, limita a saída ao worktree, ignora arquivos sensíveis e rejeita symlinks que apontam para fora. Arquivos não rastreados só entram quando a chamada define `include_untracked: true`.

A etapa `review` vai diretamente ao `codex-reviewer`. Em trabalho significativo, o fluxo esperado é planejamento, execução e revisão. Se a revisão encontrar um defeito, o router permite uma correção e uma revisão final antes de encerrar.

### Claude Agent SDK

Claude Opus 4.8 é chamado pela ferramenta `claude_agent`, que usa `@anthropic-ai/claude-agent-sdk`. A integração aceita apenas as etapas `request` e `plan` e limita as ferramentas a `Read`, `Glob` e `Grep` dentro do worktree.

O SDK bloqueia escrita, edição, Bash, rede, subagentes, skills, MCPs, persistência de sessão, caminhos externos, `.git`, `.env*` e arquivos sensíveis. `xhigh` e `max` são enviados sem rebaixamento. Cancelamento do OpenCode e timeout são propagados para a consulta.

Claude fica fora das etapas que exigem mutação. Uma classificação Claude em `execute` sobe para Codex.

## Preparação e verificação determinísticas

Antes de uma etapa GLM ou Codex que possa alterar o workspace, o router chama `stage_prepare`. A ferramenta exige que o diretório da sessão seja a raiz de um worktree Git e devolve um `baseline_id` opaco.

Depois da execução, inclusive após falha do subagente, o router chama `stage_verify` com o mesmo identificador. O verificador compara conteúdo, tipo e modo dos arquivos, separa mudanças preexistentes e calcula somente o delta líquido produzido depois do baseline.

O baseline é de uso único. Reutilização, identificador ausente ou baseline inválido produz erro de infraestrutura.

### Status

| Status | Origem | Ação do router |
| --- | --- | --- |
| `prepared` | `stage_prepare` | Guarda o `baseline_id` para a etapa |
| `pass` | Gates aplicáveis passaram | Aprova a etapa de forma determinística |
| `fail` | Um gate encontrou falha objetiva | Solicita correção usando a evidência do gate |
| `no_changes` | Nenhum delta líquido foi encontrado | Envia ao `codex-reviewer` para decidir se a entrega atende ao pedido |
| `no_applicable_gates` | Houve mudança sem regra compatível | Envia ao `codex-reviewer` |
| `infrastructure_error` | Git, baseline, comando ou timeout impediram a verificação | Envia ao `codex-reviewer` com a evidência disponível |

O runtime não usa júri LLM. Gates determinísticos aprovam resultados cobertos; o `codex-reviewer` trata somente revisão explícita e estados sem decisão determinística.

As regras atuais são:

| Regra | Condição principal | Gate |
| --- | --- | --- |
| `llm-router-tests` | CLI, configuração e verificador deste projeto | `bash tests/smoke.sh` e testes do `stage_verifier.py` |
| `llm-router-opencode-tests` | Bundle, tools, plugin ou bibliotecas do OpenCode | Teste do instalador e 15 testes Node |
| `llm-router-quality-tests` | Executor ou benchmark de qualidade | 64 testes Python |
| `pnpm-tests` | Projeto JS ou TS com script `test` | `pnpm test` |
| `python-pytest` | Projeto Python com estrutura pytest | `uv run --no-sync pytest` |
| `rust-tests` | Projeto Rust | `cargo test` |
| `go-tests` | Projeto Go | `go test ./...` |

Os gates usam listas de argumentos, `shell:false`, timeout e diretório resolvido. Todos os gates aplicáveis são executados, e a saída limitada vira evidência para a correção. Se o worker alterar o teste, manifesto ou arquivo de configuração que define um gate, o resultado vira `infrastructure_error` e segue para o reviewer. Uma mudança de `HEAD` durante o estágio produz `fail` mesmo sem delta de arquivos.

### Retry e escalada

Uma falha transitória da ferramenta `task` permite uma única repetição no mesmo subagente. Quando o OpenCode devolve um `task_id`, a repetição reutiliza a mesma sessão. Persistindo a falha, a política escala assim:

| Rota atual | Próxima rota |
| --- | --- |
| MiniMax | GLM |
| GLM | Codex |
| Claude | Codex |
| Codex | encerra e reporta |
| Codex reviewer | encerra e reporta |

Uma correção que possa mutar o workspace recebe um baseline novo e outra verificação. Retry e escalada cobrem falha de execução. O status `fail` segue o ciclo de correção baseado nos gates.

Os eventos de preparação e verificação são gravados em JSONL em `~/.config/opencode/logs/router.jsonl` na instalação padrão.

## Instalação

### Requisitos

- OpenCode instalado.
- Ollama em execução com o modelo do classificador.
- `curl`, `jq`, `perl`, `trash` e `uv` disponíveis no `PATH`.
- Autenticação OpenAI configurada no OpenCode.
- Claude Code autenticado, ou `ANTHROPIC_API_KEY` disponível no shell que inicia o OpenCode.
- `MINIMAX_API_KEY` e `ZAI_API_KEY` disponíveis no shell que inicia o OpenCode.

Baixe o classificador local:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
```

Autentique e exporte as chaves:

```bash
opencode auth login --provider openai
claude auth login
export ANTHROPIC_API_KEY="..."
export MINIMAX_API_KEY="..."
export ZAI_API_KEY="..."
```

O `claude auth login` e `ANTHROPIC_API_KEY` são alternativas. Confira o estado com `claude auth status`. Consulte a [documentação oficial de autenticação da Anthropic](https://platform.claude.com/docs/en/manage-claude/authentication).

Não publique a saída de `opencode debug config`: a versão validada durante esta integração expandiu os valores das variáveis de autenticação no diagnóstico. Para conferir agentes sem revelar tokens, use `opencode debug agent <nome>`.

### Instalar o bundle do OpenCode

O instalador resolve os caminhos a partir do próprio clone, então o repositório pode ficar em qualquer diretório. Primeiro confira as mudanças:

```bash
bash opencode/install.sh --dry-run
```

Depois instale:

```bash
bash opencode/install.sh
```

Opções disponíveis:

```text
--config-dir PATH
--backup-root PATH
--router-path PATH
--dry-run
```

Use `bash opencode/install.sh --help` para a descrição completa.

O instalador:

1. Renderiza caminhos absolutos do clone e da configuração de destino.
2. Faz preflight de todos os destinos e cria os backups necessários antes da primeira substituição.
3. Sincroniza tools, plugins, bibliotecas, configuração do classificador e verificador, gravando `opencode.jsonc` por último.
4. Mescla as dependências exigidas em `package.json`, preservando o tipo de módulo, chaves, scripts e dependências existentes. As versões exigidas pelo bundle vencem conflitos do mesmo pacote.
5. Copia cada arquivo alterado para `/tmp/claude-backups/AAAAMMDD_HHMMSS/` antes da substituição.
6. Aposenta `llm_router_prompt_guard.js`, `tools/claude_opus.ts` e `tools/delegate_task.ts` instalados por versões antigas, com backup e envio para a lixeira.
7. Mantém uma reinstalação idêntica sem reescrita nem novo backup.

O instalador mescla o manifesto e não executa um gerenciador de pacotes. O OpenCode resolve as dependências configuradas ao carregar o bundle.

O `opencode.jsonc` versionado passa a gerenciar a configuração global no diretório escolhido. Por padrão, o destino é `$XDG_CONFIG_HOME/opencode` quando essa variável existe, ou `~/.config/opencode`.

## Providers

| Provider | Modelo usado | Autenticação |
| --- | --- | --- |
| OpenAI | GPT-5.6 Sol para router, Codex e reviewer | `opencode auth login --provider openai` |
| `minimax-coding-plan` | somente `MiniMax-M3` | `MINIMAX_API_KEY` |
| `zai-coding-plan` | `glm-5.2` por API compatível com OpenAI | `ZAI_API_KEY` |
| Anthropic | Claude Opus 4.8 pelo Agent SDK | sessão do Claude Code ou `ANTHROPIC_API_KEY` |

`github-copilot` e `opencode-go` ficam em `disabled_providers`.

## Uso no OpenCode

Confirme a configuração resolvida:

```bash
opencode debug agent router
```

Inicie o OpenCode na raiz do projeto em que você quer trabalhar:

```bash
opencode .
```

Envie o pedido normalmente ao agente `router`:

```text
Planeje a migração sem downtime e depois implemente com testes.
```

O router classifica cada etapa. No exemplo, Claude pode produzir o plano, Codex executa a etapa difícil e `codex-reviewer` revisa o resultado. A resposta final informa o modelo usado em cada etapa e o status da verificação determinística.

As tarefas nativas aparecem como sessões filhas. A [documentação de agentes do OpenCode](https://opencode.ai/docs/agents/) define estas ações de navegação e atalhos padrão atuais:

| Ação | Atalho padrão | Efeito |
| --- | --- | --- |
| `session_child_first` | `<Leader>+Down` | Abre a primeira sessão filha |
| `session_child_cycle` | `Right` | Avança para a próxima filha |
| `session_child_cycle_reverse` | `Left` | Volta para a filha anterior |
| `session_parent` | `Up` | Retorna à sessão pai |

Os atalhos podem mudar se o usuário personalizar os keybindings. A chamada ao Claude ocorre como ferramenta do router e não cria uma sessão filha nativa.

## Benchmark offline

O benchmark de qualidade usa `benchmark_config.json` e `BenchmarkExecutor`. Essa configuração contém executores externos single-shot para reproduzir as rodadas históricas. Eles existem somente no benchmark offline e nunca participam do roteamento do OpenCode.

Valide dataset e executores sem consumir chamadas:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases-v2.json \
  --output /tmp/llm-router-quality.json \
  --validate-only
```

Remova `--validate-only` para executar. `--replay-report` reaplica rubricas às saídas registradas; `--selection` limita as rotas por caso; `--parallel` controla a concorrência. Consulte métricas, limitações e hashes em [BENCHMARK.md](BENCHMARK.md).

## Por que o Plano-Orchestrator-4B

O classificador foi escolhido em benchmark local no Mac mini M2 Pro, com 192 prompts rotulados e a mesma política nos três modelos:

| Modelo | Acurácia | Latência mediana | RAM |
| --- | ---: | ---: | ---: |
| Plano-Orchestrator-4B | 92,2% (177/192) | ~843 ms | 2,5 GB |
| Mellum2-12B-A2.5B | 87,0% (167/192) | ~862 ms | 8,1 GB |
| Arch-Router-1.5B | 80,2% (154/192) | ~594 ms | 1,0 GB |

O Plano teve a maior acurácia e usou cerca de um terço da RAM do Mellum. O formato nativo é `<routes>` e o JSON Schema exige uma lista com exatamente uma intenção: `{"route":["intent_name"]}`.

## Testes

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
bash tests/opencode-bundle.sh
node --test tests/claude-agent.test.mjs
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py
uv run --no-project --no-python-downloads python -m unittest tests/test_quality_eval.py
```

`tests/smoke.sh` cobre help, saída humana, contrato JSON, erros e rejeição de argumentos desconhecidos. `tests/router-prompt-guard.test.mjs` comprova a preservação literal do pedido entre a mensagem do usuário e `llm_route`. `tests/routing-eval.sh` mede a matriz de classificação. Os demais testes cobrem instalação do bundle, Agent SDK, verificação determinística e benchmark offline.
