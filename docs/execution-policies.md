# Execution policies

The profile controls tools and limits. It does not select the model or change
the routing mode.

## Profiles

| Profile | Rules added by llm-router | Recommended use |
| --- | --- | --- |
| `native` | None | Normal provider behavior with the permissions configured in OpenCode |
| `restricted` | `allow`, `ask`, and `deny` rules, plus limits | Small models, long loops, and tasks with operational risk |
| `full` | `*` with an explicit `allow` action | Supervised sessions that need every tool |

The distributed bundle uses `native` by default for every agent and model.
Restrictions apply when the user selects `restricted` or configures a specific
rule.

Activate the session profile:

```text
/router-native
/router-restricted
/router-full
```

`full` explicitly expands access. Use it only when the environment and request
justify that access.

## Mode and profile matrix

The two axes compose freely, so all nine combinations are valid: the mode
decides when the worker changes, the profile decides which tools it receives,
and neither affects the other. Changing the mode preserves the profile, and
changing the profile preserves the mode.

Three combinations are worth naming, because the pairing itself carries the
recommendation:

| Combination | Why |
| --- | --- |
| `adaptive + restricted` | Controls cost and reduces tool risk, and is the general recommendation with smaller models |
| `pinned + restricted` | Predictable loops: one worker, bounded tools |
| `pinned + full` | Every tool on a fixed worker, so use it only under supervision |

## Permission format

Rules use the OpenCode vocabulary:

```json
{
  "permission": "bash",
  "pattern": "git push*",
  "action": "deny"
}
```

Accepted actions are:

| Action | Result |
| --- | --- |
| `allow` | Authorizes the corresponding operation |
| `ask` | Requires a decision from the host or interface |
| `deny` | Blocks the operation |

The distributed `restricted` profile starts with `ask`, allows common local
queries, and denies `external_directory` and `doom_loop`. Its default limits
are:

```json
{
  "max_steps": 40,
  "max_tool_calls": 80,
  "max_child_depth": 1
}
```

Ranges validated by the runtime:

| Limit | Minimum | Maximum |
| --- | ---: | ---: |
| `max_steps` | 1 | 10000 |
| `max_tool_calls` | 1 | 100000 |
| `max_child_depth` | 0 | 1 |

Limits are enforced during execution:

| Field | Enforcement |
| --- | --- |
| `max_steps` | Counts `chat.params` calls; for Claude, it also sets `maxTurns` in the Agent SDK |
| `max_tool_calls` | Counts OpenCode tools and Claude internal tools through the callback |
| `max_child_depth` | Traverses the `parentID` chain before `task`, `agent`, or an `@agent` mention |

Exceeding a limit stops the operation with an explicit error. In the Claude
callback, the same violation becomes a controlled tool denial.

## Files and precedence

The effective policy is composed in this order:

1. Versioned bundle defaults in [`opencode/llm-router.policy.defaults.json`](../opencode/llm-router.policy.defaults.json).
2. Global user configuration in `$CONFIG_DIR/llm-router.policy.json`.
3. Project configuration in `.opencode/llm-router.policy.json`.
4. Explicit session override set by `/router-native`, `/router-restricted`, or `/router-full`.

`$CONFIG_DIR` is the OpenCode configuration directory. It defaults to
`$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`.

The global configuration can expand or restrict access. The project
configuration can only reduce permissions, select `restricted` from `native`
or `full`, and lower limits. An attempt to expand access aborts loading with an
error. This rule prevents a repository from enabling tools on its own.

The explicit session override can expand access because it represents a direct
user choice.

The installer manages `llm-router.policy.defaults.json` and
`llm-router.policy.schema.json`. It creates
`$CONFIG_DIR/llm-router.policy.json` only when the file does not exist.
Reinstallations and upgrades print `preserved` and keep the user policy
unchanged.

## Selection by agent and model

Resolution follows:

```text
defaultProfile
  -> exact agent assignment
  -> exact provider/model override
  -> explicit session override
```

The model uses an exact key such as `openai/gpt-5.6-sol`. Wildcards in
`models` are rejected.

The distributed defaults declare all four models as `native`. A persistent
policy that changes every model must therefore list all four exact IDs. A
session command has precedence over them and changes the effective profile
without repeating that list.

An assignment accepts a short string:

```json
{
  "agents": {
    "router": "restricted"
  }
}
```

It also accepts custom rules and limits:

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

## Global example: native by default, restricted Claude

File `$CONFIG_DIR/llm-router.policy.json`:

```json
{
  "schemaVersion": 1,
  "defaultProfile": "native",
  "models": {
    "claude-agent/claude-opus-5": {
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

## Global example: allow everything by default

```json
{
  "schemaVersion": 1,
  "defaultProfile": "full",
  "models": {
    "minimax-coding-plan/MiniMax-M3": "full",
    "zai-coding-plan/glm-5.2": "full",
    "claude-agent/claude-opus-5": "full",
    "openai/gpt-5.6-sol": "full"
  }
}
```

A session can still use `/router-restricted` to reduce access temporarily.

## Project example: read-only loop

File `.opencode/llm-router.policy.json`:

```json
{
  "schemaVersion": 1,
  "defaultProfile": "restricted",
  "models": {
    "minimax-coding-plan/MiniMax-M3": "restricted",
    "zai-coding-plan/glm-5.2": "restricted",
    "claude-agent/claude-opus-5": "restricted",
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

This project can lower global limits. It cannot change `restricted` to `full`,
increase `max_steps`, or convert a `deny` rule into `allow`.

## Invalid project example

If the effective global policy already uses `restricted`, this file is
rejected:

```json
{
  "schemaVersion": 1,
  "agents": {
    "router": "full"
  }
}
```

The same applies to a project that tries to raise a limit or allow a denied
permission.

## OpenCode and Claude SDK

GLM, MiniMax, and Codex enforce the rules through the OpenCode permission
surface.

Claude uses Claude Code internal tools. In the `restricted` profile, the plugin
configures a `permissionProfile` that queries the host and provides a callback
to the Agent SDK `canUseTool`. This callback maps names such as `Bash`, `Read`,
`Edit`, and `Task` to the OpenCode actions `bash`, `read`, `edit`, and `task`.
The command, path, pattern, query, URL, or prompt becomes the request resource.

The mapping preserves `allow`, `ask`, and `deny`:

- `allow` authorizes the tool in the callback.
- `deny` returns a denial to the SDK.
- `ask` queries the host; a missing callback, error, cancellation, or timeout
  results in a denial.

OpenCode evaluates the session policy patterns. Claude's default effective
approval timeout is 30 seconds.

See [Claude via Agent SDK](claude.md#claude-permissions) for details.

## Schema

The complete schema is available at
[`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json).
It validates:

- the format version;
- the three profile names;
- exact agent and model selectors;
- `allow`, `ask`, and `deny` rules;
- integer limits and their ranges;
- the absence of unknown keys.
