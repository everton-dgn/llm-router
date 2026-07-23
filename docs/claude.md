# Claude via Agent SDK

Claude Opus 4.8 é exposto ao OpenCode pelo provider local `claude-agent`. O provider implementa `LanguageModelV3` e chama `query()` de `@anthropic-ai/claude-agent-sdk`.

O executável oficial já instalado continua responsável pela autenticação. O adapter recebe o caminho absoluto por `pathToClaudeCodeExecutable` e não lê nem copia tokens.

## Fluxo

```text
mensagem do OpenCode
  -> contexto ativo v2
  -> projeção sanitizada e limitada
  -> SDKUserMessage tipada
  -> query() do Claude Agent SDK
  -> ferramentas nativas do Claude Code
  -> stream e resultado na mesma sessão do OpenCode
```

Os arquivos principais são:

- [`opencode/providers/claude_agent_provider.mjs`](../opencode/providers/claude_agent_provider.mjs)
- [`opencode/lib/claude_agent.mjs`](../opencode/lib/claude_agent.mjs)
- [`opencode/lib/claude_context.mjs`](../opencode/lib/claude_context.mjs)
- [`opencode/lib/claude_checkpoint.mjs`](../opencode/lib/claude_checkpoint.mjs)

## Contexto entre modelos

O OpenCode continua como fonte da conversa. O adapter não persiste uma sessão paralela do Claude.

Antes da chamada, o plugin lê `v2.session.context` e monta uma sequência tipada:

- mensagens históricas usam `shouldQuery: false`;
- a última mensagem é sempre o pedido atual do usuário;
- texto sintético, raciocínio e histórico arbitrário de tools ficam fora;
- resultados concluídos de `task` ou `agent` podem entrar como contexto reportado;
- mensagens posteriores ao ID atual ficam fora.

Isso permite o seguinte fluxo:

```text
Turno 1: GLM investiga a configuração
Turno 2: router escolhe Claude
Turno 2 do Claude: recebe a conversa ativa, inclusive a resposta visível do GLM
```

O limite de transporte é 2 MiB, com reserva para o envelope. A mensagem atual sempre tem prioridade. Mensagens antigas são escolhidas de trás para frente e podem ser descartadas para caber. Esse teto mede bytes serializados e não estima tokens.

## Anexos

O pedido atual pode levar texto e os seguintes tipos:

| Categoria | MIME types |
| --- | --- |
| Imagem | `image/gif`, `image/jpeg`, `image/png`, `image/webp` |
| PDF | `application/pdf` |
| Texto | `text/plain` |

Imagem e PDF aceitam dados locais codificados e URLs `http` ou `https`. Texto remoto precisa chegar como conteúdo, não como URL arbitrária. Nomes de arquivo entram somente como metadata não confiável e são normalizados antes do prompt.

Exemplos de uso no composer:

```text
[anexe architecture.png]
compare este diagrama com a implementação atual
```

```text
[anexe contract.pdf]
liste as obrigações e aponte cláusulas contraditórias
```

```text
[anexe notes.txt]
transforme estas notas em um plano de implementação
```

Base64 inválido, MIME divergente, URL com protocolo diferente de HTTP/HTTPS e anexo acima do orçamento geram erro explícito. Anexos históricos incompatíveis são descartados; o anexo atual incompatível interrompe a chamada.

## Menções e subtasks

Quando Claude é o worker escolhido, o runtime resolve até quatro menções `@agent` antes de montar o contexto do SDK. Cada menção recebe uma sessão filha do OpenCode com:

- `parentID` apontando para a conversa atual;
- o agente mencionado como executor;
- a política efetiva desse agente;
- texto e anexos do pedido atual.

As sessões filhas rodam em paralelo. O runtime espera cada uma, lê a última resposta válida de `assistant` e limita o resultado a 256 KiB. A menção original é substituída por esse texto concluído. Claude recebe o resultado dentro do pedido atual, sem metadata `agent` pendente.

Agentes gerenciados pelo router, como `router`, `router-control`, `router-auto`, `router-adaptive` e `router-manual`, não podem ser mencionados como subtasks. O perfil `restricted` também aplica `max_child_depth` antes de criar a sessão filha.

O contexto histórico aceita resultados já concluídos das ferramentas `task` e `agent`. O texto é marcado como resultado reportado e não como instrução confiável. Resultados compactados, incompletos ou com formato inválido ficam fora.

Exemplo:

```text
1. O usuário menciona `@reviewer` junto com um PDF.
2. O runtime cria uma sessão filha com o texto e o PDF.
3. `reviewer` conclui a análise.
4. A menção é substituída pelo resultado.
5. Claude recebe o pedido, o PDF e a análise concluída.
```

## Permissões do Claude

Cada perfil produz um contrato distinto:

| Perfil | Contrato do Agent SDK |
| --- | --- |
| `native` | Mantém `permissionMode: "auto"`, sem callback ou regras adicionais do llm-router |
| `restricted` | Usa modo `default`, comportamento `ask` e callback ligado às permissões do OpenCode |
| `full` | Usa modo `default` e comportamento `allow`, sem consulta por ferramenta |

Quando o perfil precisa de controle, o provider recebe:

- `permissionProfile`, com comportamento padrão e regras por nome exato de ferramenta;
- `permissionCallback`, para decisões `ask`;
- `permissionTimeoutMs`, com padrão de 30 segundos.

O callback `canUseTool` aplica:

| Regra | Resposta ao SDK |
| --- | --- |
| `allow` | Autoriza e preserva o `toolUseID` |
| `deny` | Nega com uma mensagem controlada pelo host |
| `ask` | Consulta o host com cancelamento e timeout |

`ask` falha fechado. Ausência de callback, exceção, resposta inválida, cancelamento ou timeout devolve `deny`.

Os modos do SDK aceitos pelo adapter são `acceptEdits`, `auto`, `default`, `dontAsk` e `plan`, mas combinações que não conseguem aplicar a política são rejeitadas. `dontAsk` não pode ser usado para impor um perfil que precisa consultar o host.

Mesmo com ferramentas nativas, o processo roda com:

- `safe-mode`;
- `strictMcpConfig`;
- nenhum servidor MCP injetado;
- nenhuma fonte local de settings;
- Chrome desabilitado;
- persistência de sessão do SDK desabilitada;
- ambiente filtrado para runtime, proxy, TLS e variáveis `ANTHROPIC_` ou `CLAUDE_`.

Plugins, hooks e skills locais do Claude Code não são carregados por esse transporte.

## Compactação e memória

Antes de uma compactação, o modelo local resume somente a transcrição sanitizada. O resultado segue schema fechado e é vinculado a exatamente um `compaction.id`.

O checkpoint fica em `llm-router.claude.checkpoint` na metadata. Em uma chamada futura, ele entra como recapitulação factual. Se geração, vínculo ou validação falhar, o provider usa somente a cauda ativa e mostra um aviso.

Esse trabalho ocorre na compactação. Ele não acompanha cada resposta e não adiciona um turno de orquestrador depois do worker.

## Limites e cancelamento

| Controle | Padrão |
| --- | ---: |
| Timeout total do Claude | 15 minutos |
| Timeout de permissão | 30 segundos |
| Input serializado | 2 MiB |
| Output serializado | 4 MiB |

O Agent SDK não expõe um limite aplicável equivalente a `maxOutputTokens`. Quando o OpenCode envia esse campo, o provider retorna um aviso `unsupported`. `maxOutputBytes` fornece o guardião real de memória do transporte.

O perfil `restricted` liga `max_steps` ao `maxTurns` do Agent SDK. O valor precisa ser inteiro positivo e limita as rodadas internas do Claude. O hook mantém sua própria contagem como segunda barreira. `max_tool_calls` é contado no callback das ferramentas internas, e `max_child_depth` cobre ferramentas `Task` ou `Agent` e sessões filhas abertas por menções.

Cancelar a mensagem aborta e fecha a consulta do SDK. Timeout de execução também aborta o processo.
