# Routing modes

The mode determines when a session can switch workers. Permissions remain in
the execution profile and stay independent from the mode.

## Overview

| Mode | Local classification | Worker switching | Recommended use |
| --- | --- | --- | --- |
| `auto` | On every message | Always applies the current recommendation | Independent requests and minimum per-turn cost |
| `adaptive` | On every message | Upgrades immediately and downgrades after confirmation | Conversations that evolve between simple and difficult tasks |
| `pinned` | Until the first worker is pinned | Keeps the worker for the rest of the session | Continuity of style, cache, or model behavior |

The local classifier uses the [`route`](../route) script and returns one of four
routes:

```text
minimax < glm < claude < codex
```

The `adaptive` mode uses this order for hysteresis. It represents the router's
operational progression, from the least expensive route to the route reserved
for difficult engineering, review, and security work.

## Auto

Activate it with:

```text
/router-auto
```

Every message goes through the classifier. Its recommendation applies to that
turn.

Example:

```text
Message 1: list the configuration files
Destination: MiniMax

Message 2: now fix the race condition
Destination: Codex
```

The previous worker does not control the next one. The conversation remains in
the same session, so the new worker receives the active context provided by
OpenCode.

## Adaptive

Activate it with:

```text
/router-adaptive
```

The classifier continues to run on every message. The state machine in
[`opencode/lib/adaptive_routing.mjs`](../opencode/lib/adaptive_routing.mjs)
decides whether switching is worthwhile.

Default parameters:

| Parameter | Value | Effect |
| --- | ---: | --- |
| `minimumTurnsBeforeSwitch` | 2 | Requires at least two turns on the current worker before downgrading the route |
| `downgradeConfirmations` | 2 | Requires two consecutive recommendations for the same lower route |
| `switchCooldownTurns` | 1 | Blocks another downgrade for one turn after a switch |

### Immediate upgrade

A recommendation above the current worker applies to the same message. This
avoids keeping a small model after the conversation starts requiring greater
capability.

```text
Current worker: GLM
Request: perform a complete security review of this flow
Recommendation: Codex
Result: immediate switch to Codex
```

### Confirmed downgrade

A downgrade waits for all three criteria: minimum tenure, zero cooldown, and
consecutive confirmations.

```text
Turn 1: GLM was selected, cooldown = 1
Turn 2: MiniMax recommended, confirmation 1, GLM remains, cooldown = 0
Turn 3: MiniMax recommended, confirmation 2, switch to MiniMax
```

If the downgrade recommendation changes from MiniMax to GLM, counting starts
again for the new destination. If the classifier recommends the current
worker, the pending downgrade is discarded.

### Short follow-up

Short continuation messages such as `what about the tests?`, `now this`, or
`continue` keep the current worker when the alternative would be a downgrade.
An upgrade remains immediate.

The detector accepts up to six words and 80 characters, with Portuguese or
English continuation prefixes. Its purpose is to prevent a follow-up from
depending on a model that has just lost the execution context.

## Pinned

Activate it with:

```text
/router-pinned
```

The first message sent while this mode is active is classified and pins the
result. Later messages use that destination without another classification.
Switching from `auto` or `adaptive` to `pinned` starts this selection on the
next request.

Example:

```text
/router-pinned
design the notification architecture

First selection: Claude
Following messages: Claude remains
```

The profile remains independent. A `pinned + native` session and a
`pinned + restricted` session can use the same Claude with different tool
policies.

## Session state

The user-selected control uses `llm-router.control`. It stores `mode` and the
optional `profileOverride`. The routing state machine uses
`llm-router.routing.state`. This second record contains:

- `schemaVersion`
- owner `sessionID`
- `mode`
- `currentRoute`
- `turnsOnCurrent`
- `cooldownTurnsRemaining`
- the pending downgrade, when present

Both records include the owner `sessionID`. Resuming the session preserves its
mode, profile, and route. A fork ignores inherited decisions because it receives
a different ID.

## Context when switching models

The switch changes the `agent` and `model` of the current message. It does not
create another conversation or ask the classifier to summarize the worker
response.

In practice:

1. The user remains in the same session.
2. OpenCode keeps the active history.
3. The selected worker receives this history according to the provider contract.
4. The response enters the same conversation and can be used by the next worker.

Claude receives a typed and sanitized projection of the context. Other
providers use the native OpenCode flow. See
[Claude via Agent SDK](claude.md#context-across-models).

## Resume and fork

Resuming the same session preserves the mode and effective worker because the
`sessionID` remains the same.

A fork receives a new `sessionID`. The cloned history remains available, but
inherited routing decisions are ignored. The new branch can classify and
select another worker without changing the original session.

## Compatibility

Legacy aliases remain available during migration:

| Alias | Current semantics |
| --- | --- |
| `router-auto` | `auto` |
| `router-adaptive` | `adaptive` |
| `router-manual` | `pinned` |

`router-manual` retains the legacy `llm-router.manual.target` key only to read
existing sessions. New decisions use `llm-router.routing.state`.

The composer displays `router` as the primary agent. Aliases remain hidden and
exist only for compatibility and internal resolution. After each handoff, the
notice reports the effective mode, worker, and profile.
