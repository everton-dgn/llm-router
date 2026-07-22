# llm-router

Roteador local de mensagens do OpenCode entre MiniMax M3, GLM 5.2, Claude Opus 4.8 e GPT-5.6 Sol. O composer permanece em um dos dois agentes primários: `router-auto`, que classifica cada pedido com o modelo pequeno no Ollama, ou `router-manual`, que classifica o primeiro pedido e fixa esse worker na metadata da sessão. O plugin troca o `agent` e o `model` somente na mensagem executada.

## Arquitetura

| Componente | Responsabilidade |
| --- | --- |
| `route` | Classifica pedidos e produz checkpoints locais sanitizados na compactação |
| `config.json` | Define as intenções, os destinos e as opções dos dois trabalhos locais |
| `opencode/plugins/llm_router_handoff.ts` | Executa o handoff e integra contexto e compactação do OpenCode |
| `opencode/lib/direct_handoff.mjs` | Resolve os modos automático e manual e troca `message.agent` e `message.model` |
| `opencode/lib/opencode_transport.mjs` | Reutiliza o transporte in-process do OpenCode 1.18.4 para criar o cliente v2 |
| `opencode/lib/claude_context.mjs` | Projeta, sanitiza e limita o contexto v2 enviado ao Claude |
| `opencode/lib/claude_checkpoint.mjs` | Gera, vincula e valida o checkpoint seguro de memória de longo prazo |
| `opencode/lib/routing_policy.mjs` | Mapeia rotas, declara capacidades e aplica o piso determinístico |
| `opencode/providers/claude_agent_provider.mjs` | Expõe a CLI oficial do Claude como provider `LanguageModelV3` local |
| `opencode/lib/claude_agent.mjs` | Executa `claude -p` sem ferramentas e converte o stream JSONL |
| `opencode/opencode.jsonc` | Configura o Ollama, providers nativos e o adapter local do Claude |
| `opencode/tools/repo_query.ts` | Oferece consultas read-only fixas para MiniMax |

Fluxo automático:

```text
pedido do usuário
  -> router-auto / hook chat.message
  -> route --classify --json
  -> Ollama: Plano-Orchestrator-4B
  -> piso determinístico de capacidade
  -> troca agent/model na mesma mensagem
  -> MiniMax, GLM, Claude CLI ou Codex executa
  -> resposta na sessão atual
```

Fluxo manual:

```text
pedido do usuário
  -> router-manual / hook chat.message
  -> primeiro worker classificado passa pelo piso de capacidade
  -> destino final é salvo na metadata da sessão
  -> mensagens seguintes reutilizam o mesmo worker
  -> MiniMax, GLM, Claude CLI ou Codex executa
  -> resposta na sessão atual
```

O classificador encerra depois de devolver a rota. Ele não gera plano, não chama ferramentas do projeto, não cria sessão filha do OpenCode e não espera a resposta do worker. Também não existe um turno posterior de coordenador para resumir o resultado. O modo manual não chama o classificador depois que o destino foi fixado. Quando a rota é Claude, o OpenCode chama diretamente o adapter local, que executa a CLI oficial e devolve o resultado à mesma mensagem.

O mesmo modelo local executa um segundo trabalho independente antes de uma compactação: resume somente a transcrição já sanitizada e grava um checkpoint versionado. Esse trabalho ocorre uma vez por compactação, não acompanha o worker e não roda a cada mensagem. Em caso de falha ou saída inválida, o sistema mantém apenas a cauda ativa e gera um aviso visível.

O plugin mostra um aviso de três segundos na interface, por exemplo:

```text
llm-router
Auto -> claude-agent/claude-opus-4-8
```

No modo manual, o aviso distingue `Manual fixado` de `Manual reutilizado`. Se a seleção falhar, a mensagem permanece no router primário e a execução é interrompida. Um turno posterior incompatível com a capacidade do destino fixo termina com erro e orienta a criação de outra conversa em `router-auto`. O modelo local configurado nos dois routers serve como sentinela: se o plugin não carregar, ele informa a falha de configuração e não executa o pedido.

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

MiniMax recebe somente operações literais read-only. Se o classificador devolver MiniMax para um pedido com mutação afirmativa ou para tradução, resumo, reescrita, documentação ou brainstorm, a política eleva a rota para GLM antes do handoff. Uma mutação afirmativa classificada como Claude é elevada para Codex. Pedidos que negam a mutação permanecem na rota classificada.

As permissões ficam nos agentes nativos:

- MiniMax usa somente `repo_query` para consultar o repositório.
- Claude não recebe ferramentas externas do OpenCode nem ferramentas internas da CLI. O modelo recebe somente texto.
- GLM e Codex podem editar dentro das permissões do OpenCode, mas não podem chamar `task` nem rotear outra vez.
- Commit, push, merge, rebase, reset, limpeza de Git, deploy, instalação global e comandos destrutivos ficam bloqueados. Os demais comandos mutáveis de shell exigem aprovação do OpenCode.

Os nomes dos workers existem porque o OpenCode associa permissões e prompt a um agente. Eles ficam como executores `subagent` e não aparecem como routers primários. `router-auto` e `router-manual` são os únicos agentes primários. O plugin altera apenas `output.message.agent` e `output.message.model`, sem persistir uma troca visual de agente ou modelo. Por isso o composer continua no router escolhido.

O modo manual lê e mescla a chave `llm-router.manual.target` na metadata da sessão. O registro contém o `sessionID` proprietário e o destino canônico com `agent`, `providerID` e `modelID`. Assim, uma sessão retomada continua no mesmo worker, enquanto um fork ignora a cópia herdada e classifica o primeiro pedido novamente. O modo automático consulta essa chave local para respeitar uma sessão Manual já fixada; sem um registro próprio, classifica cada mensagem novamente. Se um destino fixo não tiver capacidade para o novo pedido, ele permanece gravado e nenhuma reclassificação ocorre nessa conversa.

No OpenCode 1.18.4, o cliente legado entregue ao plugin não expõe todas as operações necessárias. O helper de compatibilidade reutiliza o `fetch` in-process para criar o cliente v2 usado em `session.get`, `session.update`, `session.switchAgent` e `session.context`. Ele não chama modelos e não abre outro listener HTTP. A dependência de `_client.getConfig()` fica isolada até o OpenCode entregar um cliente v2 público ao plugin.

## Claude via CLI oficial

Claude Opus 4.8 usa o provider local `claude-agent`. Esse provider implementa o contrato `LanguageModelV3` esperado pelo OpenCode e inicia o executável oficial do Claude Code com `claude -p`.

Autentique o Claude Code pelo fluxo oficial:

```bash
claude auth login
claude auth status
```

O adapter não lê, copia nem persiste tokens. A autenticação continua sob responsabilidade do executável `claude`, do mesmo modo que numa execução direta do Claude Code. O processo filho recebe uma lista permitida de variáveis de runtime, proxy, TLS e autenticação `ANTHROPIC_` ou `CLAUDE_`. Variáveis dos providers GLM e MiniMax e funções exportadas pelo shell ficam fora do ambiente filho.

A CLI roda com `--safe-mode`, `--tools ""`, configuração MCP vazia e estrita, slash commands e Chrome desabilitados e sem persistência de sessão. O modelo não recebe ferramenta capaz de ler o filesystem, executar comandos, abrir navegador, carregar skills ou delegar. `--system-prompt` substitui o prompt padrão por um texto constante do adapter. Esse texto reconhece a transcrição sanitizada recebida pela entrada padrão e deixa claro que não existe estado implícito da sessão Claude. Conteúdo dinâmico nunca entra nos argumentos do processo. O instalador confere no `claude --help` todas as flags usadas antes de alterar a configuração. O provider transmite os deltas de texto do `stream-json` e usa a mensagem `result` final para uso de tokens e motivo de término. Exit code diferente de zero, stderr, JSON inválido, timeout e cancelamento geram erros explícitos. Um filho que ignore `SIGTERM` recebe `SIGKILL` após o prazo.

Antes de iniciar a CLI, o plugin chama `v2.session.context` e usa somente a projeção ativa do OpenCode. A lista permitida aceita texto de `user` sem anexos e texto de `assistant` sem erro. Mensagens posteriores ao ID atual ficam fora. `system`, `synthetic`, `shell`, checkpoint nativo, raciocínio, anexos, chamadas e resultados de ferramentas nunca entram. Um anexo na mensagem atual interrompe a rota Claude com erro explícito.

O contexto ativo é limitado antes da serialização. A mensagem atual sempre permanece; a cauda anterior é escolhida de trás para frente dentro do orçamento, com aviso do provider quando mensagens antigas forem descartadas. O guardião de transporte aceita até 2 MiB e reserva 4 KiB para a instrução e o envelope JSON. Esses bytes não são apresentados como estimativa de tokens. Se a mensagem atual sozinha exceder o orçamento, a chamada falha explicitamente.

Antes de cada compactação, `route --summarize --json` recebe pela entrada padrão apenas a transcrição permitida. O resultado precisa seguir um esquema fechado, respeitar um tamanho máximo e ser vinculado posteriormente a exatamente um novo `compaction.id`. O checkpoint fica em `llm-router.claude.checkpoint` na metadata da sessão. Em compactações seguintes, o checkpoint validado anterior entra como recapitulação factual junto com a nova cauda. `summary` e `recent` produzidos pelo OpenCode nunca são reutilizados. Em caso de falha de geração, vínculo ambíguo ou metadata inválida, o sistema usa somente a cauda ativa e mostra o motivo na interface.

A CLI instalada não oferece uma opção equivalente a `maxOutputTokens`. Quando o OpenCode envia esse campo, o provider devolve um aviso `unsupported` e preserva o uso e o `stop_reason` informados pela CLI. A proteção progressiva independente usa `maxOutputBytes`, com padrão de 4 MiB. Quando a saída excede esse limite de bytes, o provider encerra o processo com erro explícito.

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
4. Fixa no `package.json` as versões do plugin e do SDK do OpenCode.
5. Copia cada arquivo alterado para `/tmp/claude-backups/AAAAMMDD_HHMMSS/`.
6. Envia tools, plugins e bibliotecas do orquestrador antigo para a lixeira.
7. Mantém reinstalações idênticas sem novo backup.

O instalador não executa gerenciador de pacotes. O OpenCode resolve `@opencode-ai/plugin` ao carregar a configuração.

Por padrão, o destino é `$XDG_CONFIG_HOME/opencode` quando essa variável existe. Nos demais casos, usa `~/.config/opencode`.

## Providers

| Provider | Modelo | Autenticação |
| --- | --- | --- |
| `ollama` | Plano-Orchestrator-4B local | Serviço em `127.0.0.1:11434` |
| `minimax-coding-plan` | MiniMax M3 | `MINIMAX_API_KEY` |
| `zai-coding-plan` | GLM 5.2 | `ZAI_API_KEY` |
| `claude-agent` | Claude Opus 4.8 | Login mantido pelo executável oficial do Claude Code |
| `openai` | GPT-5.6 Sol | Login do OpenCode |

`github-copilot` e `opencode-go` ficam em `disabled_providers`.

Evite publicar a saída de `opencode debug config`, pois ela pode expandir valores de ambiente. Para conferir cada agente sem revelar tokens, use:

```bash
opencode debug agent router-auto
opencode debug agent router-manual
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

Use `router-auto` para classificar cada pedido. Uma mensagem como "planeje a migração sem downtime" tende a ir para Claude. Uma implementação difícil tende a ir para Codex. Cada pedido produz uma classificação e uma execução, sem ciclo de plano, execução e review conduzido por outro modelo.

Use `router-manual` para classificar a primeira mensagem e manter o destino resultante nas mensagens seguintes da sessão. O plugin salva esse worker na metadata e o reutiliza sem chamar novamente o classificador. Se um pedido posterior precisar de uma capacidade ausente, o modelo permanece fixo e a execução explica que é preciso iniciar outra conversa em `router-auto`. Para obter outro destino fixo, use outra sessão. Em ambos os modos o composer permanece no router primário; `minimax`, `glm`, `claude` e `codex` executam somente o turno encaminhado.

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
node --test tests/router-handoff.test.mjs tests/claude-agent.test.mjs tests/claude-agent-provider.test.mjs tests/repo-query.test.mjs
uv run --no-project --no-python-downloads python -m unittest tests/test_stage_verifier.py
uv run --no-project --no-python-downloads python -m unittest tests/test_quality_eval.py
```

`tests/router-handoff.test.mjs` cobre os quatro destinos, Auto, fixação Manual, capacidades, negações, falhas parciais e recuperação. `tests/claude-agent.test.mjs` cobre flags, entrada padrão, JSONL, ambiente permitido, cancelamento e deadline. `tests/claude-agent-provider.test.mjs` cobre o contrato `LanguageModelV3`, contexto v2, privacidade, orçamento, checkpoints consecutivos, fallback, stream, uso e limites honestos. `tests/smoke.sh` cobre os contratos do classificador e do sumarizador local. `tests/opencode-bundle.sh` cobre os dois routers, instalação do módulo de checkpoint, dependências, compatibilidade da CLI, paths especiais, backup, aposentadoria do fluxo antigo e idempotência.
