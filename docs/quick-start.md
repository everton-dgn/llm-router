# Quick start

## Requirements

Accounts and services you must have before installing, because none of them can
be automated:

- OpenCode installed, with OpenAI authenticated.
- Claude Code installed.
- Ollama running.
- `MINIMAX_API_KEY` and `ZAI_API_KEY` available in the environment that starts
  OpenCode.

`setup.sh` checks everything else, including `curl`, `jq`, `node`, and `pnpm`,
and names the command that fixes each missing one.

## Installation

```bash
git clone https://github.com/everton-dgn/llm-router.git
cd llm-router
bash setup.sh
```

Preview every change first, without touching the OpenCode configuration:

```bash
bash setup.sh --dry-run
```

`setup.sh` accepts:

```text
--dry-run           Preview the OpenCode changes without applying them.
--dev               Also install the development toolchain and the Git hooks.
--config-dir PATH   OpenCode configuration directory. Defaults to the XDG or user config path.
--backup-root PATH  Backup root forwarded to the bundle installer.
--router-path PATH  llm-router executable forwarded to the bundle installer.
--claude-path PATH  Claude Code executable. Defaults to claude from PATH.
-h, --help          Show this help.
```

By default the configuration is installed in `$XDG_CONFIG_HOME/opencode`. When
`XDG_CONFIG_HOME` is unset, the destination is `~/.config/opencode`.

The run ends with a numbered list of whatever remains manual, each with the
exact command. On a machine that already has the Claude Code login and both API
keys, that list is empty.

Keep the clone where it is: the installed plugin stores its absolute path. If
you move it, run `bash setup.sh` again.

### What it does to an existing configuration

When `opencode.jsonc` already exists, the installer updates only the
router-owned model, default agent, providers, commands, and agents. Comments,
custom providers, custom agents, commands, and unrelated settings remain in
place. Files at retired llm-router paths are moved out of the active
configuration only when their content matches a known legacy implementation.
The timestamped backup retains their contents under `retired/`; an unrecognized
file is preserved and reported.

On the first installation, the installer creates `llm-router.policy.json` from
the defaults. Updates preserve this file without overwriting it. See
[execution policies](execution-policies.md#files-and-precedence) for both
configuration locations.

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

Every command and its exact effect: [session commands](commands.md).

## Updating

Pull the changes and run the same command:

```bash
git pull
bash setup.sh
```

Changed managed files are backed up under a timestamped directory, in the
`YYYYMMDD_HHMMSS` format, below the backup root. Running the command again on
an unchanged installation changes nothing and creates no backup.

## Verification without exposing credentials

Inspect the providers:

```bash
opencode models claude-agent
```

Inspect each agent individually, as listed in
[privacy and costs](privacy-and-costs.md).

Do not publish `opencode debug config`, because its output may expand
environment values.

## Manual installation

`setup.sh` runs these steps for you. Use them only when you need to drive one
of them separately:

```bash
ollama pull hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M
claude auth login
corepack enable
pnpm install --frozen-lockfile
opencode_config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
bash opencode/install.sh --config-dir "$opencode_config_dir"
pnpm --dir "$opencode_config_dir" install --no-optional
```

The bundle installer does not run a package manager, which is why the last
command exists. `--no-optional` makes the Agent SDK use the executable provided
through `--claude-path` instead of downloading another Claude Code binary.

## Next steps

- [Choose a routing mode](routing-modes.md)
- [Choose an execution profile](execution-policies.md)
- [Edit the route configuration](config-reference.md)
- [Understand the Claude transport](claude.md)
- [Diagnose failures](troubleshooting.md)
