# Uninstall and rollback

The installer replaces a defined set of files in the OpenCode configuration
directory and saves changed originals under
`/tmp/claude-backups/<timestamp>/`. It also preserves the user-created
`llm-router.policy.json`.

The `/router-uninstall` command removes the active integration conservatively.
It does not call an LLM and does not permanently delete bundle files.

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

## Preview the uninstall

Run this command in OpenCode:

```text
/router-uninstall
```

The command reports:

- each affected path and its planned action;
- the router-owned entries that it will remove from shared configuration;
- the bundle files that it will move out of the active configuration;
- the items it will preserve because their ownership is ambiguous;
- a confirmation token bound to fingerprints of every affected file.

The preview does not change the configuration or create a recovery directory.
Review it before continuing.

## Apply the preview

Use the token printed by the preview:

```text
/router-uninstall <token>
```

The command recalculates the affected-file fingerprints before making any
change. If a file changed after the preview, the command stops without applying
the stale plan. Run `/router-uninstall` again to review the current state and
receive another token.

Before editing shared `package.json` or `opencode.jsonc`, the command saves their
current contents. It edits only router-owned entries and keeps unrelated
providers, agents, commands, dependencies, scripts, comments, and settings.

Only after a valid confirmation does the command create a recovery directory
under:

```text
$CONFIG_DIR/.llm-router-backups/uninstall/<timestamp>/
```

The final response prints its resolved path. Keep that path until you have
verified the remaining OpenCode configuration.

`llm-router.policy.json` is always preserved because it may contain user-created
permission rules. Legacy installations without complete ownership metadata use
a conservative fallback. Files or shared entries whose ownership cannot be
proved may remain in place and are listed in the result for manual review.

Restart OpenCode after the command completes. The running process may still
have the previous plugin loaded until restart.

## Roll back an automatic uninstall

1. Close every OpenCode process using the target configuration.
2. Open the recovery path printed by `/router-uninstall <token>`.
3. Inspect the saved files:

   ```bash
   config_dir="/absolute/path/to/opencode"
   recovery_dir="/absolute/path/printed/by/router-uninstall"
   find "$recovery_dir" -type f -print
   ```

4. Restore each shared configuration file present under `shared/`:

   ```bash
   cp -p "$recovery_dir/shared/opencode.jsonc" "$config_dir/opencode.jsonc"
   cp -p "$recovery_dir/shared/package.json" "$config_dir/package.json"
   ```

   A shared file is present only when the uninstall changed it.

5. Restore every file under `removed/` to the same relative path under the
   configuration directory. For example:

   ```bash
   mkdir -p "$config_dir/plugins"
   cp -p \
     "$recovery_dir/removed/plugins/llm_router_handoff.ts" \
     "$config_dir/plugins/llm_router_handoff.ts"
   cp -p \
     "$recovery_dir/removed/llm-router.install-state.json" \
     "$config_dir/llm-router.install-state.json"
   ```

   Restore only paths present in the selected recovery directory. Preserve their
   relative paths, modes, and timestamps.

6. Run the package manager for the restored `package.json`.
7. Restart OpenCode and inspect the active agents.

The command intentionally keeps `.llm-router-backups` after uninstall. It may
contain the installation baseline and the recovery data needed to reverse the
operation. This directory does not load providers, plugins, or agents into
OpenCode.

## Restore an installation backup manually

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

The installation backup contains only files that existed and changed. Files
first introduced by llm-router have no previous copy and need the manual
procedure below.

## Remove files introduced by llm-router

Keep `package.json` and `opencode.jsonc`. They are shared OpenCode configuration
files and may contain unrelated providers, scripts, or dependencies. Restore
them from the selected backup. When no backup exists, remove only the entries
introduced by llm-router after reviewing the current JSON.

The same rule applies to any path that already existed before installation. If
the selected backup contains that relative path, restore the backup instead of
removing the file.

The following paths are exclusive to the current llm-router bundle when they
were absent before installation:

```text
/absolute/path/to/opencode/plugins/llm_router_handoff.ts
/absolute/path/to/opencode/providers/claude_agent_provider.mjs
/absolute/path/to/opencode/providers/router_control_provider.mjs
/absolute/path/to/opencode/llm-router.policy.defaults.json
/absolute/path/to/opencode/llm-router.policy.schema.json
/absolute/path/to/opencode/tools/repo_query.ts
/absolute/path/to/opencode/lib/adaptive_routing.mjs
/absolute/path/to/opencode/lib/claude_agent.mjs
/absolute/path/to/opencode/lib/claude_checkpoint.mjs
/absolute/path/to/opencode/lib/claude_context.mjs
/absolute/path/to/opencode/lib/direct_handoff.mjs
/absolute/path/to/opencode/lib/execution_policy.mjs
/absolute/path/to/opencode/lib/install_state.mjs
/absolute/path/to/opencode/lib/uninstall.mjs
/absolute/path/to/opencode/lib/opencode_transport.mjs
/absolute/path/to/opencode/lib/repo_query.mjs
/absolute/path/to/opencode/lib/route_contract.mjs
/absolute/path/to/opencode/lib/router_control.mjs
/absolute/path/to/opencode/lib/routing_policy.mjs
/absolute/path/to/opencode/lib/session_metadata.mjs
/absolute/path/to/opencode/llm-router.install-state.json
```

Compare each candidate with the same file in this repository before removing
it.
The `TARGETS` array in `opencode/install.sh` is an installation manifest, not a
safe deletion list.

Keep `llm-router.policy.json` unless you have confirmed it was created only for
this router and no longer contains user configuration.

Keep `.llm-router-backups` while any installation baseline or uninstall recovery
may still be needed. Its contents are intentionally retained and are not part of
the active OpenCode bundle.

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
