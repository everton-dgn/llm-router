# mellum-router

Roteador local de modelos. Dado um prompt, o Mellum 2 (rodando no Ollama, no
seu Mac) decide qual modelo deve atender à tarefa e abre a CLI interativa dele
numa janela nova do Ghostty, com o prompt já enviado, pronta para você interagir
e aprovar permissões.

O Mellum não executa a tarefa. Ele apenas classifica o prompt e escolhe a rota;
quem faz o trabalho é a CLI do modelo escolhido, que abre para você trabalhar.

## Uso

```bash
route "otimiza essa query lenta"          # dry-run: só mostra a rota escolhida
route --run "otimiza essa query lenta"     # abre a CLI do modelo numa janela do Ghostty
```

Sem `--run`, o comando apenas mostra a decisão e não abre nada. Com `--run`, abre
a CLI interativa do modelo (via seus aliases do `~/.zshrc`) numa janela nova do
Ghostty, com o prompt já enviado.

## Como funciona

O modelo `mellum-router-v2` (registrado no Ollama) carrega a política de
roteamento gravada como system prompt. O `route` envia apenas o prompt do
usuário; o Ollama injeta a política e o modelo responde com uma linha JSON
`{"model": "..."}`. O script mapeia esse rótulo para o alias da CLI
correspondente e abre uma janela do Ghostty rodando `zsh -i` (para carregar os
aliases) com a CLI e o prompt.

Mapeamento (rótulo do roteador → alias do `~/.zshrc`):

| Rótulo    | Alias | CLI aberta                |
|-----------|-------|---------------------------|
| `claude`  | `cld` | Claude Code (opus)        |
| `codex`   | `cdx` | Codex CLI (gpt-5.6-sol)   |
| `minimax` | `m3`  | Claude Code + MiniMax-M3  |
| `glm`     | `glm` | Claude Code + GLM-5.2     |

Para trocar o alias de um rótulo, edite o `case` dentro do `route`.

## Ajustar a política de roteamento

As regras vivem no `Modelfile.router.v2`, na seção `SYSTEM`. Para mudar os
critérios ou acrescentar exemplos:

1. Edite o `Modelfile.router.v2`.
2. Recrie o modelo no Ollama:

   ```bash
   ollama create mellum-router-v2 -f ~/mellum-router/Modelfile.router.v2
   ```

Os exemplos dentro do `SYSTEM` são a forma mais barata de melhorar a precisão:
cada exemplo ensina onde fica a fronteira entre duas rotas parecidas.

## Arquivos

| Arquivo                 | O que é                                             |
|-------------------------|-----------------------------------------------------|
| `route`                 | o comando (roteia e abre a CLI do modelo)           |
| `Modelfile.router.v2`   | a política de roteamento (recria o modelo no Ollama)|
| `router-system-v2.txt`  | o system prompt em texto puro (referência)          |

## Requisitos

- Ollama em execução (sobe sozinho no login, é app).
- Modelo `mellum-router-v2` registrado no Ollama.
- Ghostty instalado (a CLI abre numa janela nova).
- Os aliases `cld`, `cdx`, `m3` e `glm` definidos no `~/.zshrc`.
- `jq` e `curl` disponíveis no PATH.

## Instalação em outra máquina

1. Copie esta pasta para `~/mellum-router` e torne o `route` executável:

   ```bash
   cp -R ~/www/dotfiles/config/mellum-router ~/mellum-router
   chmod +x ~/mellum-router/route
   ```

2. Adicione ao PATH no `~/.zshrc`:

   ```zsh
   export PATH="$HOME/mellum-router:$PATH"
   ```

3. Baixe o modelo e crie a variante do roteador:

   ```bash
   ollama pull hf.co/JetBrains/Mellum2-12B-A2.5B-Instruct-GGUF-Q4_K_M
   ollama create mellum-router-v2 -f ~/mellum-router/Modelfile.router.v2
   ```

4. Garanta que os aliases `cld`, `cdx`, `m3` e `glm` existam no `~/.zshrc`.
