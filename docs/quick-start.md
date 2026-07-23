# Início rápido

## Requisitos

- OpenCode instalado.
- Claude Code instalado e autenticado.
- Ollama em execução.
- O modelo local `hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M` disponível no Ollama.
- OpenAI autenticado no OpenCode.
- `MINIMAX_API_KEY` e `ZAI_API_KEY` no ambiente que inicia o OpenCode.
- `curl`, `jq`, `node`, `pnpm` e `trash` no `PATH`.

Baixe o classificador local:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
```

Autentique o Claude Code:

```bash
claude auth login
claude auth status
```

## Instalação

Confira o que será alterado:

```bash
bash opencode/install.sh --dry-run
```

Instale o bundle:

```bash
bash opencode/install.sh
```

O instalador aceita:

```text
--config-dir PATH
--backup-root PATH
--router-path PATH
--claude-path PATH
--dry-run
```

Por padrão, a configuração fica em `$XDG_CONFIG_HOME/opencode`. Sem `XDG_CONFIG_HOME`, o destino é `~/.config/opencode`.

O instalador não executa um gerenciador de pacotes. Instale as dependências da configuração depois da cópia:

```bash
cd "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
pnpm install --no-optional
```

`--no-optional` faz o Agent SDK usar o executável informado por `--claude-path`, sem baixar outro binário do Claude Code.

## Primeiro uso

Abra o projeto:

```bash
opencode .
```

O agente principal é `router`. Consulte o estado da sessão:

```text
/router-status
```

Escolha o modo e o perfil antes do pedido, quando quiser sair dos padrões:

```text
/router-adaptive
/router-native
```

Depois envie uma tarefa normal:

```text
revise a estratégia de cache e corrija o problema encontrado
```

O classificador local só escolhe a rota. O worker selecionado executa o pedido na mesma mensagem e na mesma sessão.

## Comandos da sessão

| Comando | Efeito |
| --- | --- |
| `/router-auto` | Classifica e aplica a rota em cada mensagem |
| `/router-adaptive` | Classifica cada mensagem e evita trocas desnecessárias |
| `/router-pinned` | Fixa o primeiro worker selecionado enquanto esse modo está ativo |
| `/router-native` | Remove restrições adicionais do llm-router |
| `/router-restricted` | Aplica permissões e limites do perfil restrito |
| `/router-full` | Autoriza explicitamente todas as ferramentas do perfil |
| `/router-status` | Mostra modo e perfil base da sessão |

Os comandos de modo e de perfil alteram eixos diferentes. Usar `/router-pinned` preserva o perfil atual. Usar `/router-restricted` preserva o modo atual.

Os sete comandos usam o provider local `router-control` e respondem sem chamar Ollama, Claude, GLM, MiniMax ou OpenAI. Os comandos de modo e perfil atualizam a metadata; `/router-status` apenas lê o estado. O uso reportado pelo provider é zero. Exemplo:

```text
Router status. mode: adaptive | profile: native
```

Um override exato de modelo pode produzir outro perfil no próximo handoff. Nesse caso, o aviso da mensagem mostra o perfil efetivo junto com o worker.

## Atualização

Execute primeiro o dry-run:

```bash
bash opencode/install.sh --dry-run
```

Depois aplique:

```bash
bash opencode/install.sh
```

Arquivos gerenciados que mudaram recebem backup em `/tmp/claude-backups/AAAAMMDD_HHMMSS/`. Na primeira instalação, o instalador cria `llm-router.policy.json` a partir dos defaults. Atualizações preservam esse arquivo sem sobrescrevê-lo. Consulte [políticas de execução](execution-policies.md#arquivos-e-precedência) para os dois locais de configuração.

## Verificação sem expor credenciais

Confira os providers:

```bash
opencode models claude-agent
```

Confira os agentes individualmente:

```bash
opencode debug agent router
opencode debug agent minimax
opencode debug agent glm
opencode debug agent claude
opencode debug agent codex
```

Evite publicar `opencode debug config`, pois a saída pode expandir valores do ambiente.

## Próximos passos

- [Escolher o modo de roteamento](routing-modes.md)
- [Escolher o perfil de execução](execution-policies.md)
- [Entender o transporte do Claude](claude.md)
- [Diagnosticar falhas](troubleshooting.md)
