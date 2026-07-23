# Políticas de execução

O perfil controla ferramentas e limites. Ele não escolhe o modelo e não muda o modo de roteamento.

## Perfis

| Perfil | Regras adicionadas pelo llm-router | Uso indicado |
| --- | --- | --- |
| `native` | Nenhuma | Uso normal do provider e das permissões configuradas no OpenCode |
| `restricted` | Regras `allow`, `ask` e `deny`, mais limites | Modelos pequenos, loops longos e tarefas com risco operacional |
| `full` | `*` com `allow` explícito | Sessões supervisionadas que precisam de todas as ferramentas |

O bundle distribuído usa `native` como padrão para todos os agentes e modelos. Restrições passam a existir quando o usuário escolhe `restricted` ou configura uma regra específica.

Ative o perfil da sessão:

```text
/router-native
/router-restricted
/router-full
```

`full` amplia poder de forma explícita. Use apenas quando o ambiente e o pedido justificarem.

## Matriz modo x perfil

Todas as combinações são válidas:

| Combinação | Comportamento |
| --- | --- |
| `auto + native` | Troca a cada mensagem e usa permissões nativas |
| `auto + restricted` | Troca a cada mensagem e aplica os limites restritos ao worker escolhido |
| `auto + full` | Troca a cada mensagem com autorização ampla |
| `adaptive + native` | Evita trocas desnecessárias e usa permissões nativas |
| `adaptive + restricted` | Controla custo e reduz risco de ferramentas, indicado para uso geral com modelos menores |
| `adaptive + full` | Mantém histerese de modelo, mas libera ferramentas |
| `pinned + native` | Fixa o worker e preserva o comportamento nativo |
| `pinned + restricted` | Fixa o worker com limites, indicado para loops previsíveis |
| `pinned + full` | Fixa o worker e libera ferramentas, indicado somente com supervisão |

Mudar o modo preserva o perfil. Mudar o perfil preserva o modo.

## Formato das permissões

As regras usam o vocabulário do OpenCode:

```json
{
  "permission": "bash",
  "pattern": "git push*",
  "action": "deny"
}
```

As ações aceitas são:

| Ação | Resultado |
| --- | --- |
| `allow` | Autoriza a operação correspondente |
| `ask` | Exige decisão do host ou da interface |
| `deny` | Bloqueia a operação |

O perfil `restricted` distribuído começa com `ask`, permite consultas locais comuns e nega `external_directory` e `doom_loop`. Os limites padrão são:

```json
{
  "max_steps": 40,
  "max_tool_calls": 80,
  "max_child_depth": 1
}
```

Faixas validadas pelo runtime:

| Limite | Mínimo | Máximo |
| --- | ---: | ---: |
| `max_steps` | 1 | 10000 |
| `max_tool_calls` | 1 | 100000 |
| `max_child_depth` | 0 | 1 |

Os limites são aplicados durante a execução:

| Campo | Fiscalização |
| --- | --- |
| `max_steps` | Conta chamadas de `chat.params`; no Claude também define `maxTurns` no Agent SDK |
| `max_tool_calls` | Conta tools do OpenCode e ferramentas internas do Claude pelo callback |
| `max_child_depth` | Percorre a cadeia `parentID` antes de `task`, `agent` ou uma menção `@agent` |

Ultrapassar um limite interrompe a operação com erro explícito. No callback do Claude, a mesma violação vira uma negação controlada para a ferramenta.

## Arquivos e precedência

A política efetiva é composta nesta ordem:

1. Defaults versionados do bundle em [`opencode/llm-router.policy.defaults.json`](../opencode/llm-router.policy.defaults.json).
2. Configuração global do usuário em `$CONFIG_DIR/llm-router.policy.json`.
3. Configuração do projeto em `.opencode/llm-router.policy.json`.
4. Override explícito da sessão feito pelos comandos `/router-native`, `/router-restricted` ou `/router-full`.

`$CONFIG_DIR` é o diretório de configuração do OpenCode. O padrão é `$XDG_CONFIG_HOME/opencode` ou `~/.config/opencode`.

A configuração global pode ampliar ou restringir. A configuração do projeto só pode reduzir permissões, escolher `restricted` a partir de `native` ou `full` e diminuir limites. Uma tentativa de ampliar encerra a carga com erro. Essa regra impede que um repositório habilite ferramentas por conta própria.

O override explícito da sessão pode ampliar porque ele representa uma escolha direta do usuário.

O instalador gerencia `llm-router.policy.defaults.json` e `llm-router.policy.schema.json`. Ele cria `$CONFIG_DIR/llm-router.policy.json` somente quando o arquivo ainda não existe. Reinstalações e upgrades imprimem `preserved` e mantêm a política do usuário intacta.

## Seleção por agente e modelo

A resolução segue:

```text
defaultProfile
  -> assignment exato do agent
  -> override exato provider/model
  -> override explícito da sessão
```

O modelo usa uma chave exata, como `openai/gpt-5.6-sol`. Wildcards em `models` são rejeitados.

Os defaults distribuídos declaram os quatro modelos como `native`. Por isso, uma política persistente que queira mudar todos eles precisa listar os quatro IDs exatos. Um comando de sessão tem precedência sobre todos e muda o perfil efetivo sem repetir essa lista.

O assignment aceita uma string curta:

```json
{
  "agents": {
    "router": "restricted"
  }
}
```

Também aceita regras e limites próprios:

```json
{
  "agents": {
    "router": {
      "profile": "restricted",
      "permissions": [
        { "permission": "bash", "pattern": "*", "action": "deny" }
      ],
      "limits": {
        "max_steps": 20,
        "max_tool_calls": 30,
        "max_child_depth": 0
      }
    }
  }
}
```

## Exemplo global: tudo nativo, Claude restrito

Arquivo `$CONFIG_DIR/llm-router.policy.json`:

```json
{
  "schemaVersion": 1,
  "defaultProfile": "native",
  "models": {
    "claude-agent/claude-opus-4-8": {
      "profile": "restricted",
      "limits": {
        "max_steps": 30,
        "max_tool_calls": 50,
        "max_child_depth": 1
      }
    }
  }
}
```

## Exemplo global: liberar tudo por padrão

```json
{
  "schemaVersion": 1,
  "defaultProfile": "full",
  "models": {
    "minimax-coding-plan/MiniMax-M3": "full",
    "zai-coding-plan/glm-5.2": "full",
    "claude-agent/claude-opus-4-8": "full",
    "openai/gpt-5.6-sol": "full"
  }
}
```

Uma sessão ainda pode usar `/router-restricted` para reduzir o poder temporariamente.

## Exemplo de projeto: loop read-only

Arquivo `.opencode/llm-router.policy.json`:

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

Esse projeto pode reduzir os limites globais. Ele não pode trocar `restricted` por `full`, aumentar `max_steps` ou converter uma regra `deny` em `allow`.

## Exemplo de projeto inválido

Se a política efetiva global já usa `restricted`, este arquivo é rejeitado:

```json
{
  "schemaVersion": 1,
  "agents": {
    "router": "full"
  }
}
```

O mesmo vale para um projeto que tenta elevar um limite ou liberar uma permissão negada.

## OpenCode e Claude SDK

GLM, MiniMax e Codex executam as regras pela superfície de permissões do OpenCode.

Claude usa ferramentas internas do Claude Code. No perfil `restricted`, o plugin configura um `permissionProfile` que consulta o host e fornece um callback ao `canUseTool` do Agent SDK. Esse callback converte nomes como `Bash`, `Read`, `Edit` e `Task` para as ações `bash`, `read`, `edit` e `task` do OpenCode. Comando, path, pattern, query, URL ou prompt entram como recursos da solicitação.

O mapeamento preserva `allow`, `ask` e `deny`:

- `allow` autoriza a ferramenta no callback.
- `deny` devolve uma negação ao SDK.
- `ask` consulta o host; ausência de callback, erro, cancelamento ou timeout termina em negação.

O OpenCode avalia os patterns da política da sessão. O timeout efetivo padrão de aprovação do Claude é 30 segundos.

Consulte os detalhes em [Claude via Agent SDK](claude.md#permissões-do-claude).

## Schema

O schema completo fica em [`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json). Ele valida:

- versão do formato;
- nomes dos três perfis;
- seletores exatos de agentes e modelos;
- regras `allow`, `ask` e `deny`;
- limites inteiros e suas faixas;
- ausência de chaves desconhecidas.
