# Session commands

Reference for the eight `/router-*` commands. They run on the local
`router-control` provider and never call Ollama, Claude, GLM, MiniMax, or
OpenAI. Mode and profile commands update session metadata; `/router-status`
only reads it. The provider reports zero usage.

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

Mode and profile are separate axes. `/router-pinned` preserves the current
profile; `/router-restricted` preserves the current mode.

`/router-status` prints:

```text
Router status. mode: adaptive | profile: native
```

An exact model override may produce a different profile on the next handoff. In
that case the message notice shows the effective profile alongside the worker.

## Uninstalling

Run `/router-uninstall` once to inspect the planned changes and receive a
confirmation token. Apply that exact preview with:

```text
/router-uninstall <token>
```

The second command stops if an affected file changed after the preview. A
successful uninstall preserves the user policy, saves shared configuration
before editing it, and moves bundle files into the recovery directory reported
in the response. Restart OpenCode after it completes. See
[uninstall and rollback](uninstall.md) for legacy-installation behavior and
recovery instructions.
