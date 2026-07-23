# llm-router

Roteador local de mensagens do OpenCode entre MiniMax M3, GLM 5.2, Claude Opus 4.8 e GPT-5.6 Sol. O composer permanece no agente principal `router`; o plugin escolhe o worker da mensagem e mostra o destino efetivo na interface.

O produto separa duas decisões:

- modo de roteamento: `auto`, `adaptive` ou `pinned`;
- perfil de execução: `native`, `restricted` ou `full`.

O modo decide quando trocar de modelo. O perfil decide ferramentas e limites. Todas as nove combinações são válidas.

## Documentação

- [Início rápido](docs/quick-start.md)
- [Modos de roteamento, contexto e fork](docs/routing-modes.md)
- [Perfis, permissões e configuração](docs/execution-policies.md)
- [Claude via Agent SDK, anexos e subtasks](docs/claude.md)
- [Diagnóstico e segurança](docs/troubleshooting.md)

## Arquitetura

| Componente | Responsabilidade |
| --- | --- |
| `route` | Classifica pedidos e produz checkpoints locais sanitizados na compactação |
| `config.json` | Define as intenções, os destinos e as opções dos dois trabalhos locais |
| `opencode/plugins/llm_router_handoff.ts` | Executa o handoff e integra contexto e compactação do OpenCode |
| `opencode/lib/direct_handoff.mjs` | Resolve o modo da sessão e troca `message.agent` e `message.model` |
| `opencode/lib/adaptive_routing.mjs` | Mantém estado, histerese e compatibilidade dos modos de roteamento |
| `opencode/lib/execution_policy.mjs` | Carrega, valida, mescla e resolve perfis de execução |
| `opencode/lib/router_control.mjs` | Persiste comandos, aplica permissões e fiscaliza limites |
| `opencode/lib/opencode_transport.mjs` | Reutiliza o transporte in-process do OpenCode 1.18.4 para criar o cliente v2 |
| `opencode/lib/claude_context.mjs` | Projeta, sanitiza e limita o contexto v2 enviado ao Claude |
| `opencode/lib/claude_checkpoint.mjs` | Gera, vincula e valida o checkpoint seguro de memória de longo prazo |
| `opencode/lib/routing_policy.mjs` | Mapeia as quatro rotas para seus destinos |
| `opencode/providers/claude_agent_provider.mjs` | Expõe o Claude Agent SDK como provider `LanguageModelV3` local |
| `opencode/providers/router_control_provider.mjs` | Responde aos comandos do router localmente, com uso zero de tokens |
| `opencode/lib/claude_agent.mjs` | Configura `query()`, ferramentas, ambiente, cancelamento e deadline do Claude |
| `opencode/llm-router.policy.defaults.json` | Define perfis e assignments distribuídos |
| `opencode/llm-router.policy.schema.json` | Valida configurações globais e de projeto |
| `opencode/opencode.jsonc` | Configura o router, os workers, os comandos e os providers |
| `opencode/tools/repo_query.ts` | Oferece consultas auxiliares read-only a qualquer worker |

Fluxo de uma mensagem:

```text
pedido do usuário no router
  -> hook chat.message
  -> lê modo e perfil da sessão
  -> route --classify --json
  -> Ollama: Plano-Orchestrator-4B
  -> auto, adaptive ou pinned decide o destino efetivo
  -> troca agent/model na mesma mensagem
  -> MiniMax, GLM, Claude Agent SDK ou Codex executa
  -> resposta na sessão atual
```

O classificador encerra depois de devolver a rota. Ele não gera plano, não chama ferramentas do projeto, não cria sessão filha do OpenCode e não espera a resposta do worker. Também não existe um turno posterior de coordenador para resumir o resultado. No modo `pinned`, o destino já fixado é reutilizado. Quando a rota é Claude, o OpenCode chama diretamente o provider local, que usa `query()` do Agent SDK e devolve o resultado à mesma mensagem.

O mesmo modelo local executa um segundo trabalho independente antes de uma compactação: resume somente a transcrição já sanitizada e grava um checkpoint versionado. Esse trabalho ocorre uma vez por compactação, não acompanha o worker e não roda a cada mensagem. Em caso de falha ou saída inválida, o sistema mantém apenas a cauda ativa e gera um aviso visível.

O plugin mostra o modo, o worker e o perfil efetivos na interface. Exemplo:

```text
llm-router
Adaptive -> claude-agent/claude-opus-4-8 | Native
```

Se a seleção falhar, a mensagem permanece no router e a execução é interrompida. Um turno incompatível com o transporte do destino termina com erro explícito. O modelo local configurado no router serve como sentinela: se o plugin não carregar, ele informa a falha de configuração e não executa o pedido.

## Classificador local

A saída humana mostra a decisão:

```bash
./route "otimiza essa query lenta"
```

```text
rota: codex -> GPT-5.6 Sol (xhigh)
```

A integração usa um contrato JSON fechado e versionado:

```bash
./route --classify --json "traduza este parágrafo para inglês"
```

```json
{"schema_version":1,"intent":"translation_simple_brainstorm_docs_or_intermediate_work","route":"glm"}
```

Erros também contêm `schema_version` e um objeto `error` com `code` e `message`. O classificador usa `/api/chat` do Ollama com `think:false` e restringe a saída por JSON Schema. Resposta vazia, rota desconhecida e JSON inválido encerram a chamada sem fallback silencioso.

Consulte todos os argumentos com:

```bash
./route --help
```

## Matriz de rotas

| Intenção | Rota | Destino no OpenCode | Uso principal |
| --- | --- | --- | --- |
| `literal_read_only_no_writing` | `minimax` | `minimax-coding-plan/MiniMax-M3` | Contagem, listagem, busca, extração e formatação literal |
| `translation_simple_brainstorm_docs_or_intermediate_work` | `glm` | `zai-coding-plan/glm-5.2` | Tradução e trabalho simples ou intermediário |
| `complex_creative_product_or_architecture` | `claude` | `claude-agent/claude-opus-4-8` | Arquitetura, produto, estratégia e criação complexa |
| `review_security_hard_engineering_or_technical_writing` | `codex` | `openai/gpt-5.6-sol` | Engenharia difícil, revisão, segurança e texto técnico |

As rotas expressam preferência de custo e capacidade. Elas não retiram ferramentas do modelo. O perfil de execução aplica permissões de forma independente:

- `native` não acrescenta restrições do llm-router;
- `restricted` aplica regras e limites configuráveis;
- `full` adiciona `allow` explícito para todas as ferramentas.

O bundle usa `native` como padrão. Consulte a [matriz modo x perfil](docs/execution-policies.md#matriz-modo-x-perfil) e os [exemplos de política](docs/execution-policies.md#exemplo-global-tudo-nativo-claude-restrito).

Os workers existem porque o OpenCode associa modelo e prompt a um agente. Eles ficam como executores `subagent`; `router` permanece como agente principal do composer. O plugin altera `output.message.agent` e `output.message.model` apenas para executar a mensagem.

O estado usa a chave `llm-router.routing.state` na metadata da sessão. Ela contém o `sessionID` proprietário, o modo, a rota atual, os turnos e o cooldown. Retomar a sessão preserva a decisão. Um fork recebe outro `sessionID`, mantém o histórico clonado e faz uma decisão de roteamento independente.

Comportamento dos modos:

- `auto` aplica a classificação de cada mensagem;
- `adaptive` sobe de rota imediatamente e exige confirmação para reduzir;
- `pinned` mantém o primeiro worker da sessão.

Os parâmetros padrão do `adaptive` são `minimumTurnsBeforeSwitch=2`, `downgradeConfirmations=2` e `switchCooldownTurns=1`. Consulte [modos de roteamento](docs/routing-modes.md).

No OpenCode 1.18.4, o cliente legado entregue ao plugin não expõe todas as operações necessárias. O helper de compatibilidade reutiliza o `fetch` in-process para criar o cliente v2 usado em `session.get`, `session.update`, `session.switchAgent` e `session.context`. Ele não chama modelos e não abre outro listener HTTP. A dependência de `_client.getConfig()` fica isolada até o OpenCode entregar um cliente v2 público ao plugin.

## Claude via Agent SDK oficial

Claude Opus 4.8 usa o provider local `claude-agent`. Esse provider implementa o contrato `LanguageModelV3` esperado pelo OpenCode e chama `query()` de `@anthropic-ai/claude-agent-sdk`. A opção `pathToClaudeCodeExecutable` aponta para o executável já instalado na máquina, evitando depender do binário opcional empacotado pelo SDK.

Autentique o Claude Code pelo fluxo oficial:

```bash
claude auth login
claude auth status
```

O adapter não lê, copia nem persiste tokens. A autenticação continua sob responsabilidade do executável `claude`, do mesmo modo que numa execução direta do Claude Code. O processo interno do SDK recebe uma lista permitida de variáveis de runtime, proxy, TLS e autenticação `ANTHROPIC_` ou `CLAUDE_`. Variáveis dos providers GLM e MiniMax e funções exportadas pelo shell ficam fora desse ambiente.

O SDK roda com as ferramentas padrão do Claude Code. No perfil `native`, usa `permissionMode: "auto"` sem regras adicionais do llm-router. Nos demais perfis, o plugin traduz `allow`, `ask` e `deny` para `permissionProfile` e `canUseTool`. Uma consulta `ask` sem callback, cancelada, expirada ou com erro termina em negação.

`safe-mode`, fontes de configuração vazias, MCP estrito e Chrome desabilitado impedem que plugins, hooks, skills ou servidores MCP locais alterem o contrato. Leitura, edição, Bash e as demais ferramentas internas continuam disponíveis conforme o perfil efetivo. A sessão do SDK não é persistida porque o OpenCode permanece como fonte da conversa. Timeout e cancelamento abortam e fecham a consulta.

Antes de chamar o SDK, o plugin consulta `v2.session.context` e usa somente a projeção ativa do OpenCode. Texto visível de `user` e `assistant`, anexos suportados e resultados concluídos de `task` ou `agent` podem entrar. Mensagens posteriores ao ID atual, texto sintético, raciocínio e histórico arbitrário de tools ficam fora.

Claude aceita `text/plain`, `application/pdf`, GIF, JPEG, PNG e WebP. O adapter valida MIME, base64, protocolo e orçamento antes de chamar o SDK. Menções `@agent` são executadas em sessões filhas do OpenCode e substituídas pelo resultado concluído antes da chamada ao Claude. Consulte [anexos, menções e subtasks](docs/claude.md#anexos).

O contexto ativo é limitado antes da serialização. A mensagem atual sempre permanece; a cauda anterior é escolhida de trás para frente dentro do orçamento, com aviso do provider quando mensagens antigas forem descartadas. O guardião de transporte aceita até 2 MiB e reserva 4 KiB para a instrução e o envelope JSON. Esses bytes não são apresentados como estimativa de tokens. Se a mensagem atual sozinha exceder o orçamento, a chamada falha explicitamente.

Antes de cada compactação, `route --summarize --json` recebe pela entrada padrão apenas a transcrição permitida. O resultado precisa seguir um esquema fechado, respeitar um tamanho máximo e ser vinculado posteriormente a exatamente um novo `compaction.id`. O checkpoint fica em `llm-router.claude.checkpoint` na metadata da sessão. Em compactações seguintes, o checkpoint validado anterior entra como recapitulação factual junto com a nova cauda. `summary` e `recent` produzidos pelo OpenCode nunca são reutilizados. Em caso de falha de geração, vínculo ambíguo ou metadata inválida, o sistema usa somente a cauda ativa e mostra o motivo na interface.

O Agent SDK não oferece uma opção equivalente a `maxOutputTokens`. Quando o OpenCode envia esse campo, o provider devolve um aviso `unsupported` e preserva o uso e o `stop_reason` informados pelo SDK. A proteção de transporte usa `maxOutputBytes`, com padrão de 4 MiB. Quando a saída excede esse limite, o provider encerra a consulta com erro explícito.

No perfil `restricted`, `max_steps` também é enviado ao Agent SDK como `maxTurns`, além da contagem feita pelo hook. `max_tool_calls` cobre ferramentas internas do Claude pelo callback, e `max_child_depth` cobre `Task`, `Agent` e menções explícitas do OpenCode.

Depois da instalação, confira o destino sem imprimir credenciais:

```bash
opencode models claude-agent
```

## Instalação

### Requisitos

- OpenCode instalado.
- Claude Code instalado e autenticado.
- Ollama em execução com o modelo do classificador.
- `curl`, `jq`, `node` e `trash` disponíveis no `PATH`.
- `script` disponível quando a versão do Claude truncar `--help` fora de um TTY.
- OpenAI autenticado no OpenCode.
- `MINIMAX_API_KEY` e `ZAI_API_KEY` no processo que inicia o OpenCode.

Baixe o classificador:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
```

Faça um preflight sem alterar a configuração:

```bash
bash opencode/install.sh --dry-run
```

Instale o bundle:

```bash
bash opencode/install.sh
```

Opções:

```text
--config-dir PATH
--backup-root PATH
--router-path PATH
--claude-path PATH
--dry-run
```

O instalador:

1. Renderiza os caminhos absolutos de `route`, do provider local e do executável `claude`.
2. Valida todos os destinos antes da primeira substituição.
3. Preserva dependências e scripts já presentes em `package.json`, exceto dependências aposentadas.
4. Fixa no `package.json` as versões do plugin, do SDK do OpenCode e do Claude Agent SDK.
5. Copia cada arquivo alterado para `/tmp/claude-backups/AAAAMMDD_HHMMSS/`.
6. Envia tools, plugins e bibliotecas do orquestrador antigo para a lixeira.
7. Instala defaults e schema da política, preservando `llm-router.policy.json` criado pelo usuário.
8. Mantém reinstalações idênticas sem novo backup.

O instalador não executa gerenciador de pacotes. Instale as dependências da configuração com `pnpm install --no-optional` para usar o executável indicado por `--claude-path` sem baixar o binário opcional do Agent SDK.

Por padrão, o destino é `$XDG_CONFIG_HOME/opencode` quando essa variável existe. Nos demais casos, usa `~/.config/opencode`.

## Providers

| Provider | Modelo | Autenticação |
| --- | --- | --- |
| `ollama` | Plano-Orchestrator-4B local | Serviço em `127.0.0.1:11434` |
| `minimax-coding-plan` | MiniMax M3 | `MINIMAX_API_KEY` |
| `zai-coding-plan` | GLM 5.2 | `ZAI_API_KEY` |
| `claude-agent` | Claude Opus 4.8 | Login mantido pelo executável oficial do Claude Code |
| `openai` | GPT-5.6 Sol | Login do OpenCode |
| `router-control` | Controle determinístico | Sem autenticação e sem chamada de LLM |

`github-copilot` e `opencode-go` ficam em `disabled_providers`.

Evite publicar a saída de `opencode debug config`, pois ela pode expandir valores de ambiente. Para conferir cada agente sem revelar tokens, use:

```bash
opencode debug agent router
opencode debug agent minimax
opencode debug agent glm
opencode debug agent claude
opencode debug agent codex
```

## Uso no OpenCode

Inicie o OpenCode no projeto em que deseja trabalhar:

```bash
opencode .
```

O padrão usa `router` com modo `adaptive` e perfil `native`. Consulte ou mude o estado com:

```text
/router-status
/router-auto
/router-adaptive
/router-pinned
/router-native
/router-restricted
/router-full
```

Os comandos de modo preservam o perfil. Os comandos de perfil preservam o modo. Veja exemplos completos no [início rápido](docs/quick-start.md#comandos-da-sessão).

## Benchmark offline

O benchmark de qualidade usa `benchmark_config.json` e `BenchmarkExecutor`. Os executores externos single-shot reproduzem as rodadas históricas e ficam fora do runtime do OpenCode.

Valide o dataset e os executores sem consumir chamadas:

```bash
uv run --no-project --no-python-downloads python quality_eval.py \
  --config benchmark_config.json \
  --cases tests/quality-cases-v2.json \
  --output /tmp/llm-router-quality.json \
  --validate-only
```

Remova `--validate-only` para executar. Consulte métricas, limitações e hashes em [BENCHMARK.md](BENCHMARK.md).

O classificador foi escolhido em benchmark local com 192 prompts rotulados:

| Modelo | Acurácia | Latência mediana | RAM |
| --- | ---: | ---: | ---: |
| Plano-Orchestrator-4B | 92,2% (177/192) | cerca de 843 ms | 2,5 GB |
| Mellum2-12B-A2.5B | 87,0% (167/192) | cerca de 862 ms | 8,1 GB |
| Arch-Router-1.5B | 80,2% (154/192) | cerca de 594 ms | 1,0 GB |

## Componentes experimentais

`stage_verifier.py`, `quality_eval.py` e `qeval/` continuam versionados para os benchmarks e experimentos determinísticos. Eles não são instalados no OpenCode e não participam do handoff de produção.

## Testes

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
bash tests/opencode-bundle.sh
node --test tests/router-handoff.test.mjs tests/execution-policy.test.mjs tests/router-control.test.mjs tests/claude-agent.test.mjs tests/claude-agent-provider.test.mjs tests/repo-query.test.mjs
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py
uv run --no-project --no-python-downloads python -m unittest tests/test_quality_eval.py
```

`tests/router-handoff.test.mjs` cobre os quatro destinos e os modos `auto`, `adaptive` e `pinned`. `tests/execution-policy.test.mjs` cobre precedência, assignments, perfis, limites e a regra de que projetos só restringem. `tests/router-control.test.mjs` cobre comandos locais, permissões, limites e menções em sessões filhas. `tests/claude-agent.test.mjs` cobre opções do SDK, ferramentas, permissões, ambiente, cancelamento e deadline. `tests/claude-agent-provider.test.mjs` cobre `LanguageModelV3`, contexto v2, anexos, checkpoints, stream, uso e limites. `tests/smoke.sh` cobre o classificador e o sumarizador local. `tests/opencode-bundle.sh` cobre instalação, upgrade, backup e idempotência.
