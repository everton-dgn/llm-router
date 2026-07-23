# Documentação do llm-router

O llm-router mantém uma conversa do OpenCode e escolhe, por mensagem, qual worker deve executá-la. A seleção de modelo e o controle de ferramentas são eixos independentes.

## Por onde começar

| Documento | Quando usar |
| --- | --- |
| [Início rápido](quick-start.md) | Instalar, atualizar e executar os primeiros comandos |
| [Modos de roteamento](routing-modes.md) | Entender `auto`, `adaptive`, `pinned`, contexto, retomada e fork |
| [Políticas de execução](execution-policies.md) | Escolher `native`, `restricted` ou `full` e configurar permissões |
| [Claude via Agent SDK](claude.md) | Entender contexto, anexos, subtasks, ferramentas e autenticação do Claude |
| [Diagnóstico e segurança](troubleshooting.md) | Corrigir falhas e configurar modelos pequenos ou loops longos |

## Modelo mental

Uma sessão tem duas decisões separadas:

1. O modo de roteamento decide quando o worker pode mudar.
2. O perfil de execução decide quais ferramentas e limites o worker recebe.

Exemplo: `adaptive + restricted` pode trocar de GLM para Codex quando o risco aumenta, mas mantém as restrições de ferramentas. `pinned + native` fixa o primeiro worker e deixa cada provider operar com o comportamento nativo.

Os componentes que implementam esse contrato ficam em:

- [`opencode/lib/adaptive_routing.mjs`](../opencode/lib/adaptive_routing.mjs)
- [`opencode/lib/direct_handoff.mjs`](../opencode/lib/direct_handoff.mjs)
- [`opencode/lib/execution_policy.mjs`](../opencode/lib/execution_policy.mjs)
- [`opencode/lib/router_control.mjs`](../opencode/lib/router_control.mjs)
- [`opencode/plugins/llm_router_handoff.ts`](../opencode/plugins/llm_router_handoff.ts)
- [`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json)
