# Modos de roteamento

O modo define quando uma sessão pode trocar de worker. As permissões ficam no perfil de execução e continuam independentes do modo.

## Visão geral

| Modo | Classificação local | Troca de worker | Uso indicado |
| --- | --- | --- | --- |
| `auto` | Em toda mensagem | Sempre aplica a recomendação atual | Pedidos independentes e custo mínimo por turno |
| `adaptive` | Em toda mensagem | Sobe imediatamente e reduz com confirmação | Conversas que evoluem entre tarefas simples e difíceis |
| `pinned` | Até fixar o primeiro worker | Mantém o worker pelo restante da sessão | Continuidade de estilo, cache ou comportamento do modelo |

O classificador local usa o script [`route`](../route) e retorna uma das quatro rotas:

```text
minimax < glm < claude < codex
```

Essa ordem é usada pela histerese do modo `adaptive`. Ela expressa a progressão operacional adotada pelo router, da rota mais econômica até a rota reservada para engenharia difícil, revisão e segurança.

## Auto

Ative com:

```text
/router-auto
```

Cada mensagem passa pelo classificador. A recomendação é aplicada naquele turno.

Exemplo:

```text
Mensagem 1: liste os arquivos de configuração
Destino: MiniMax

Mensagem 2: agora corrija a condição de corrida
Destino: Codex
```

O worker anterior não controla o próximo. A conversa continua na mesma sessão, então o worker novo recebe o contexto ativo que o OpenCode fornece.

## Adaptive

Ative com:

```text
/router-adaptive
```

O classificador continua rodando em toda mensagem. A máquina de estados em [`opencode/lib/adaptive_routing.mjs`](../opencode/lib/adaptive_routing.mjs) decide se a troca compensa.

Parâmetros padrão:

| Parâmetro | Valor | Efeito |
| --- | ---: | --- |
| `minimumTurnsBeforeSwitch` | 2 | Exige pelo menos dois turnos no worker atual antes de reduzir a rota |
| `downgradeConfirmations` | 2 | Exige duas recomendações consecutivas para a mesma rota inferior |
| `switchCooldownTurns` | 1 | Bloqueia nova redução por um turno depois de uma troca |

### Subida imediata

Uma recomendação acima do worker atual é aplicada na mesma mensagem. Isso evita manter um modelo pequeno quando a conversa passa a exigir uma capacidade maior.

```text
Worker atual: GLM
Pedido: faça uma revisão de segurança completa deste fluxo
Recomendação: Codex
Resultado: troca imediata para Codex
```

### Redução confirmada

Uma redução aguarda os três critérios: permanência mínima, cooldown zerado e confirmações consecutivas.

```text
Turno 1: GLM foi selecionado, cooldown = 1
Turno 2: MiniMax recomendado, confirmação 1, GLM permanece, cooldown = 0
Turno 3: MiniMax recomendado, confirmação 2, troca para MiniMax
```

Se a recomendação de redução mudar de MiniMax para GLM, a contagem começa outra vez para o novo destino. Se o classificador recomendar o worker atual, a redução pendente é descartada.

### Follow-up curto

Mensagens curtas de continuidade, como `e os testes?`, `agora isso` ou `continue`, mantêm o worker atual quando a alternativa seria uma redução. Uma subida continua imediata.

O detector aceita até seis palavras e 80 caracteres, com prefixos de continuidade em português ou inglês. O objetivo é impedir que um follow-up dependa de um modelo que acabou de perder o fio da execução.

## Pinned

Ative com:

```text
/router-pinned
```

A primeira mensagem enviada enquanto o modo está ativo é classificada e fixa o resultado. Mensagens posteriores usam esse destino sem nova classificação. Trocar de `auto` ou `adaptive` para `pinned` inicia essa seleção no próximo pedido.

Exemplo:

```text
/router-pinned
desenhe a arquitetura de notificações

Primeira seleção: Claude
Mensagens seguintes: Claude permanece
```

O perfil continua independente. Uma sessão `pinned + native` e outra `pinned + restricted` podem usar o mesmo Claude com políticas de ferramentas diferentes.

## Estado da sessão

O controle escolhido pelo usuário usa `llm-router.control`. Ele guarda `mode` e o `profileOverride` opcional. A máquina de roteamento usa `llm-router.routing.state`. Esse segundo registro contém:

- `schemaVersion`
- `sessionID` proprietário
- `mode`
- `currentRoute`
- `turnsOnCurrent`
- `cooldownTurnsRemaining`
- redução pendente, quando existe

Os dois registros incluem o `sessionID` proprietário. Retomar a sessão preserva modo, perfil e rota. Um fork ignora as decisões herdadas porque recebe outro ID.

## Contexto ao trocar de modelo

A troca modifica o `agent` e o `model` da mensagem atual. Ela não cria outra conversa e não pede ao classificador para resumir a resposta do worker.

Na prática:

1. O usuário continua na mesma sessão.
2. O OpenCode mantém o histórico ativo.
3. O worker selecionado recebe esse histórico conforme o contrato do provider.
4. A resposta entra na mesma conversa e pode ser usada pelo próximo worker.

Claude recebe uma projeção tipada e sanitizada do contexto. Os demais providers usam o fluxo nativo do OpenCode. Consulte [Claude via Agent SDK](claude.md#contexto-entre-modelos).

## Retomada e fork

Retomar a mesma sessão preserva o modo e o worker efetivo porque o `sessionID` continua igual.

Um fork recebe um novo `sessionID`. O histórico clonado permanece disponível, mas as decisões de roteamento herdadas são ignoradas. O novo ramo pode classificar e escolher outro worker sem alterar a sessão original.

## Compatibilidade

Aliases antigos continuam úteis durante a migração:

| Alias | Semântica atual |
| --- | --- |
| `router-auto` | `auto` |
| `router-adaptive` | `adaptive` |
| `router-manual` | `pinned` |

`router-manual` preserva a chave antiga `llm-router.manual.target` apenas para ler sessões existentes. Novas decisões usam `llm-router.routing.state`.

O composer mostra `router` como agente principal. Os aliases ficam ocultos e existem apenas para compatibilidade e resolução interna. Depois de cada handoff, o aviso informa modo, worker e perfil efetivos.
