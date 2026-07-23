# Uninstall and rollback

The installer replaces a defined set of files in the OpenCode configuration
directory and saves changed originals under
`/tmp/claude-backups/<timestamp>/`. It also preserves the user-created
`llm-router.policy.json`.

There is no automatic uninstall command yet. Rollback is intentionally manual
so the project does not guess which files belong to another OpenCode setup.

## Find the installed configuration

The default directory is:

```text
$XDG_CONFIG_HOME/opencode
```

When `XDG_CONFIG_HOME` is unset, OpenCode uses:

```text
~/.config/opencode
```

If installation used `--config-dir`, use that exact directory.

## Restore the previous configuration

1. Close every OpenCode process using the target configuration.
2. Locate the backup path printed by the installer.
3. Inspect the backup before copying anything:

   ```bash
   find /tmp/claude-backups/<timestamp> -type f -print
   ```

4. Copy each backed-up file to the same relative path under the OpenCode
   configuration directory. Preserve modes and timestamps:

   ```bash
   cp -p /tmp/claude-backups/<timestamp>/package.json \
     /absolute/path/to/opencode/package.json
   ```

5. Repeat the copy only for files present in the selected backup.
6. Run the package manager for the restored `package.json`.
7. Start OpenCode and inspect the active agents.

The backup contains only files that existed and changed. Files first introduced
by llm-router have no previous copy and need the removal procedure below.

## Remove files introduced by llm-router

Never move `package.json` or `opencode.jsonc` to the trash. They are shared
OpenCode configuration files and may contain unrelated providers, scripts, or
dependencies. Restore them from the selected backup. When no backup exists,
remove only the entries introduced by llm-router after reviewing the current
JSON.

The same rule applies to any path that already existed before installation. If
the selected backup contains that relative path, restore the backup instead of
removing the file.

The following paths are exclusive to the current llm-router bundle when they
were absent before installation:

```bash
trash /absolute/path/to/opencode/plugins/llm_router_handoff.ts
trash /absolute/path/to/opencode/providers/claude_agent_provider.mjs
trash /absolute/path/to/opencode/providers/router_control_provider.mjs
trash /absolute/path/to/opencode/llm-router.policy.defaults.json
trash /absolute/path/to/opencode/llm-router.policy.schema.json
trash /absolute/path/to/opencode/tools/repo_query.ts
trash /absolute/path/to/opencode/lib/adaptive_routing.mjs
trash /absolute/path/to/opencode/lib/claude_agent.mjs
trash /absolute/path/to/opencode/lib/claude_checkpoint.mjs
trash /absolute/path/to/opencode/lib/claude_context.mjs
trash /absolute/path/to/opencode/lib/direct_handoff.mjs
trash /absolute/path/to/opencode/lib/execution_policy.mjs
trash /absolute/path/to/opencode/lib/opencode_transport.mjs
trash /absolute/path/to/opencode/lib/repo_query.mjs
trash /absolute/path/to/opencode/lib/route_contract.mjs
trash /absolute/path/to/opencode/lib/router_control.mjs
trash /absolute/path/to/opencode/lib/routing_policy.mjs
trash /absolute/path/to/opencode/lib/session_metadata.mjs
```

Compare each candidate with the same file in this repository before moving it.
The `TARGETS` array in `opencode/install.sh` is an installation manifest, not a
safe deletion list.

Keep `llm-router.policy.json` unless you have confirmed it was created only for
this router and no longer contains user configuration.

## Validate rollback

```bash
opencode debug agent router
opencode models
```

If the previous setup did not define `router`, the first command should report
that it is absent. The model list and any unrelated agents should remain
available.

Backups under `/tmp` are not durable across every system cleanup policy. Copy a
known-good backup to protected storage before a long migration window.
