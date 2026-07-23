# Diagnóstico e segurança

## O router respondeu em vez do worker

Mensagem típica:

```text
the llm-router handoff plugin is unavailable
```

O modelo local do agente principal funciona como sentinela. Essa resposta indica que o hook não trocou a mensagem para um worker.

Verifique:

```bash
bash opencode/install.sh --dry-run
opencode debug agent router
```

Confirme também a presença do plugin e das bibliotecas no diretório de configuração do OpenCode.

## O classificador local falhou

Teste o Ollama:

```bash
curl -fsS http://127.0.0.1:11434/api/tags
```

Teste o contrato fechado:

```bash
./route --classify --json "liste os arquivos do projeto"
```

A saída precisa ser JSON com `schema_version`, `intent` e `route`. Resposta vazia, JSON inválido e rota desconhecida interrompem o handoff.

## O modelo não mudou no modo adaptive

Consulte:

```text
/router-status
```

Uma subida para rota maior é imediata. Uma redução exige dois turnos no worker atual, duas confirmações consecutivas e cooldown zerado. Follow-up curto também preserva o worker quando a alternativa seria uma redução.

Se quiser aplicar cada recomendação sem histerese:

```text
/router-auto
```

## O modelo não mudou no modo pinned

Esse é o comportamento esperado. `pinned` preserva o worker da sessão. Troque para:

```text
/router-auto
```

ou:

```text
/router-adaptive
```

Abrir um fork também permite uma decisão independente porque o novo ramo recebe outro `sessionID`.

## A configuração do projeto foi rejeitada

Projetos só podem restringir. Procure por uma destas tentativas:

- trocar `restricted` por `native` ou `full`;
- converter `deny` em `ask` ou `allow`;
- converter `ask` em `allow`;
- aumentar `max_steps`, `max_tool_calls` ou `max_child_depth`;
- usar wildcard em uma chave de `models`;
- incluir chave desconhecida.

Valide o formato contra [`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json).

## Claude não aparece

Confira a autenticação e o provider:

```bash
claude auth status
opencode models claude-agent
```

O instalador também verifica se o executável suporta as flags exigidas pelo Agent SDK.

## Claude recusou um anexo ou uma menção

Confira o MIME. O adapter aceita imagens GIF, JPEG, PNG e WebP, PDF e texto simples.

Outras causas:

- base64 inválido;
- MIME declarado diferente do data URL;
- URL que não usa HTTP ou HTTPS;
- anexo ou mensagem atual acima do orçamento de 2 MiB;
- mais de quatro menções `@agent` na mesma mensagem;
- menção a `router` ou outro agente interno gerenciado;
- sessão filha acima de `max_child_depth`;
- subtask sem resposta textual ou com resultado acima de 256 KiB.

O runtime resolve as menções em sessões filhas antes de chamar o Claude. Se o adapter informar que ainda recebeu um `agent attachment` (anexo de agente), confira se o plugin e `router_control.mjs` vieram da mesma versão. Consulte [menções e subtasks](claude.md#menções-e-subtasks).

## Claude pediu permissão e parou

No perfil `restricted`, uma regra `ask` precisa de callback do host. O adapter nega depois de 30 segundos, ou antes se ocorrer erro, cancelamento ou ausência de callback.

Consulte o estado:

```text
/router-status
```

Para usar o comportamento normal do provider:

```text
/router-native
```

Para permitir todas as ferramentas da sessão, com supervisão:

```text
/router-full
```

## Loop longo com modelo pequeno

Use:

```text
/router-adaptive
/router-restricted
```

Depois reduza os limites no projeto:

```json
{
  "schemaVersion": 1,
  "defaultProfile": "restricted",
  "models": {
    "minimax-coding-plan/MiniMax-M3": "restricted",
    "zai-coding-plan/glm-5.2": "restricted",
    "claude-agent/claude-opus-4-8": "restricted",
    "openai/gpt-5.6-sol": "restricted"
  },
  "profiles": {
    "restricted": {
      "permissions": [
        { "permission": "bash", "pattern": "*", "action": "deny" },
        { "permission": "edit", "pattern": "*", "action": "deny" },
        { "permission": "task", "pattern": "*", "action": "deny" }
      ],
      "limits": {
        "max_steps": 12,
        "max_tool_calls": 20,
        "max_child_depth": 0
      }
    }
  }
}
```

`adaptive` permite subir para um worker mais capaz quando o pedido ficar difícil. `restricted` impede que essa troca amplie ferramentas por consequência.

## Worker pequeno com pouca memória

O modelo local de 4B só classifica e encerra. Ele não guarda o contexto da conversa, não executa ferramentas do projeto e não espera o worker terminar.

O contexto fica no OpenCode. Cada worker recebe a conversa ativa conforme seu provider. Esse desenho mantém o custo do coordenador pequeno e evita exigir memória longa do classificador.

## Upgrade alterou arquivos gerenciados

Rode:

```bash
bash opencode/install.sh --dry-run
```

Arquivos gerenciados recebem backup antes da substituição. O instalador cria `llm-router.policy.json` uma vez e preserva seu conteúdo nos upgrades. Reinstalações idênticas ficam sem novo backup.

## Testes de regressão

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
bash tests/opencode-bundle.sh
node --test \
  tests/router-handoff.test.mjs \
  tests/execution-policy.test.mjs \
  tests/router-control.test.mjs \
  tests/claude-agent.test.mjs \
  tests/claude-agent-provider.test.mjs \
  tests/repo-query.test.mjs
```
