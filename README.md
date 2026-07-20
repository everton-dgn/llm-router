# llm-router

Roteador local de modelos. Dado um prompt, um classificador local (Plano-Orchestrator-4B,
base Qwen3-4B, rodando no Ollama) decide qual modelo deve atender à tarefa e abre a CLI
interativa dele numa janela nova do Ghostty, com o prompt já enviado, pronta para você
interagir e aprovar permissões.

O classificador não executa a tarefa. Ele apenas escolhe a rota; quem faz o trabalho é a
CLI do modelo escolhido, que abre para você trabalhar.

## Uso

```bash
route "otimiza essa query lenta"          # dry-run: só mostra a rota escolhida
route --run "otimiza essa query lenta"     # abre a CLI do modelo numa janela do Ghostty
```

Sem `--run`, o comando apenas mostra a decisão e não abre nada. Com `--run`, abre a CLI
interativa do modelo (via seus aliases do `~/.zshrc`) numa janela nova do Ghostty, com o
prompt já enviado.

## Como funciona

O `route` monta a política de roteamento (4 rotas com descrição) no formato nativo do
Plano-Orchestrator, chama o modelo via Ollama (`/api/chat`, com `think:false` e um schema
JSON restrito às 4 rotas) e recebe de volta o rótulo da rota. O script mapeia esse rótulo
para o alias da CLI correspondente e abre uma janela do Ghostty rodando `zsh -i` (para
carregar os aliases) com a CLI e o prompt.

Mapeamento (rótulo do classificador → alias do `~/.zshrc`):

| Rótulo    | Alias | CLI aberta                |
|-----------|-------|---------------------------|
| `claude`  | `cld` | Claude Code (opus)        |
| `codex`   | `cdx` | Codex CLI (gpt-5.6-sol)   |
| `minimax` | `m3`  | Claude Code + MiniMax-M3  |
| `glm`     | `glm` | Claude Code + GLM-5.2     |

Tudo isso é configurável no `config.json` ao lado do `route`: o modelo, o endpoint, as 4
rotas (nome, descrição e alias da CLI), o fallback (`default_route`) e os parâmetros de
geração (`options`). Editar rotas ou critérios não exige tocar no script. Se o modelo não
escolher nenhuma rota, usa-se o `default_route` (no benchmark, as abstenções eram tarefas
mecânicas).

## Por que o Plano-Orchestrator-4B

Escolhido por benchmark local (Mac mini M2 Pro, 192 prompts rotulados, mesma política nos
três modelos):

| Modelo                | Acurácia         | Latência mediana | RAM    |
|-----------------------|------------------|------------------|--------|
| Plano-Orchestrator-4B | 92.2% (177/192)  | ~843 ms          | 2.5 GB |
| Mellum2-12B-A2.5B     | 87.0% (167/192)  | ~862 ms          | 8.1 GB |
| Arch-Router-1.5B      | 80.2% (154/192)  | ~594 ms          | 1.0 GB |

O Plano venceu em acurácia com 3x menos RAM que o Mellum. Requer `think:false` (o Qwen3 põe
a resposta no campo `thinking` por padrão) e o formato nativo `<routes>`, com saída em lista
`{"route": [...]}`.

## Requisitos

- Ollama em execução.
- Modelo do classificador baixado:

  ```bash
  ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
  ```

- Ghostty instalado (a CLI abre numa janela nova).
- Os aliases `cld`, `cdx`, `m3` e `glm` definidos no `~/.zshrc`.
- `jq` e `curl` disponíveis no PATH.

## Instalação

O repositório vive em `~/www/ai/llm-router` e o `route` é exposto via PATH no `~/.zshrc`:

```bash
export PATH="$HOME/www/ai/llm-router:$PATH"
```
