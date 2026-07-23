# Quick start

## Requirements

- OpenCode installed.
- Claude Code installed and authenticated.
- Ollama running.
- The local `hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M` model
  available in Ollama.
- OpenAI authenticated in OpenCode.
- `MINIMAX_API_KEY` and `ZAI_API_KEY` in the environment that starts OpenCode.
- `curl`, `jq`, `node`, and `pnpm` in `PATH`.

Pull the local classifier:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
```

Authenticate Claude Code:

```bash
claude auth login
claude auth status
```

## Installation

Install the repository tooling. The root `postinstall` script installs the
versioned Lefthook configuration in a Git checkout and skips hook installation
in CI:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Preview the changes:

```bash
opencode_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
bash opencode/install.sh --config-dir "$opencode_config_dir" --dry-run
```

Install the bundle:

```bash
bash opencode/install.sh --config-dir "$opencode_config_dir"
pnpm --dir "$opencode_config_dir" install --no-optional
```

The installer accepts:

```text
--config-dir PATH
--backup-root PATH
--router-path PATH
--claude-path PATH
--dry-run
```

By default, the configuration is installed in `$XDG_CONFIG_HOME/opencode`.
When `XDG_CONFIG_HOME` is unset, the destination is `~/.config/opencode`.

The installer does not run a package manager. The second command uses the same
`opencode_config_dir`, including when installation targets a custom directory.
`--no-optional` makes the Agent SDK use the executable provided through
`--claude-path` instead of downloading another Claude Code binary.

When `opencode.jsonc` already exists, the installer updates only the
router-owned model, default agent, providers, commands, and agents. Comments,
custom providers, custom agents, commands, and unrelated settings remain in
place. Files at retired llm-router paths are moved out of the active
configuration only when their content matches a known legacy implementation.
The timestamped backup retains their contents under `retired/`; an
unrecognized file is preserved and reported.

## First use

Open the project:

```bash
opencode .
```

The primary agent is `router`. Check the session status:

```text
/router-status
```

Choose the mode and profile before the request when you want to override the
defaults:

```text
/router-adaptive
/router-native
```

Then send a normal task:

```text
review the cache strategy and fix the problem you find
```

The local classifier only selects the route. The selected worker executes the
request in the same message and session.

## Session commands

| Command | Effect |
| --- | --- |
| `/router-auto` | Classifies and applies a route to every message |
| `/router-adaptive` | Classifies every message and avoids unnecessary switches |
| `/router-pinned` | Keeps the first selected worker while this mode is active |
| `/router-native` | Removes additional llm-router restrictions |
| `/router-restricted` | Applies the restricted profile's permissions and limits |
| `/router-full` | Explicitly allows every tool in the profile |
| `/router-status` | Shows the session's base mode and profile |
| `/router-uninstall` | Previews a recoverable uninstall and returns a confirmation token |

Mode and profile commands change separate axes. Using `/router-pinned` preserves
the current profile. Using `/router-restricted` preserves the current mode.

All commands use the local `router-control` provider and respond without calling
Ollama, Claude, GLM, MiniMax, or OpenAI. Mode and profile commands update
metadata; `/router-status` only reads state. The provider reports zero usage.
For example:

```text
Router status. mode: adaptive | profile: native
```

An exact model override may produce a different profile on the next handoff. In
that case, the message notice shows the effective profile alongside the worker.

To uninstall, run `/router-uninstall` once to inspect the planned changes and
receive a confirmation token. Apply that exact preview with:

```text
/router-uninstall <token>
```

The second command stops if an affected file changed after the preview. A
successful uninstall preserves the user policy, saves shared configuration
before editing it, and moves bundle files into the recovery directory reported
in the response. Restart OpenCode after completion. See
[uninstall and rollback](uninstall.md) for legacy-installation behavior and
recovery instructions.

## Updating

Run the dry run first:

```bash
bash opencode/install.sh --dry-run
```

Then apply the update:

```bash
bash opencode/install.sh
```

Changed managed files are backed up under
`/tmp/claude-backups/AAAAMMDD_HHMMSS/`. On the first installation, the
installer creates `llm-router.policy.json` from the defaults. Updates preserve
this file without overwriting it. See
[execution policies](execution-policies.md#files-and-precedence) for both
configuration locations.

## Verification without exposing credentials

Inspect the providers:

```bash
opencode models claude-agent
```

Inspect each agent individually:

```bash
opencode debug agent router
opencode debug agent minimax
opencode debug agent glm
opencode debug agent claude
opencode debug agent codex
```

Do not publish `opencode debug config`, because its output may expand
environment values.

## Next steps

- [Choose a routing mode](routing-modes.md)
- [Choose an execution profile](execution-policies.md)
- [Understand the Claude transport](claude.md)
- [Diagnose failures](troubleshooting.md)
