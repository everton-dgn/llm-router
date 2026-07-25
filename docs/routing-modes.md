# Routing modes

The mode determines when a session can switch workers. Permissions remain in
the execution profile and stay independent from the mode.

## Overview

| Mode | Local classification | Worker switching | Recommended use |
| --- | --- | --- | --- |
| `auto` | On every message | Always applies the current recommendation | Independent requests and minimum per-turn cost |
| `adaptive` | On every message | Upgrades immediately and downgrades after confirmation | Conversations that evolve between simple and difficult tasks |
| `pinned` | Until the first worker is pinned | Keeps the worker for the rest of the session | Continuity of style, cache, or model behavior |

The local classifier uses the [`route`](../route) script and returns an exact
schema 1 decision with `intent` and `route`. The default manifest contains:

```text
minimax < glm < claude < codex
```

Each route has a unique integer `order`. The `adaptive` mode uses that configured
order for hysteresis, so adding or removing routes does not require a runtime
code change. The default progression moves from the least expensive route to
the route reserved for difficult engineering, review, and security work.

Route capabilities are checked independently after classification. A route
that lacks a capability required by the request is promoted to an eligible
route, while the classifier intent remains unchanged.

## Attachments

Every route declares the media types it reads in `acceptedMediaTypes`. The
shipped manifest gives MiniMax images, video, and plain text; GLM no
attachments; Claude the six types its adapter accepts; and Codex any image plus
PDF and plain text. The classified route is kept whenever it accepts every
attached file, so a message with text plus an image stays on the route the
classifier chose. A route that
rejects one of the attachments is replaced by the closest route above it that
accepts all of them, and only then by a cheaper one. In `adaptive` this switch
happens on the same message, ignoring cooldown and hysteresis. In `pinned` the
compatible route serves that single message and the session keeps its pinned
route for the next compatible one. A message with files and no text reuses the
session route when it accepts every attachment, otherwise it starts on the
cheapest compatible route.

An attachment with no usable media type is treated as
`application/octet-stream`, so it only reaches a route that declares that type.
When no route accepts every attachment, the message stops before any worker
runs and the TUI shows the rejected media types. A forced fallback also shows
one toast, for example:

```text
glm -> claude: image/png not supported
```

## Routing feedback

A toast reports the routing mode, the selected route, and the execution profile:

```text
adaptive -> claude-agent/claude-opus-5 · native
```

It fires when one of those three changes, not on every message, and a slash
command always confirms itself with its own toast. `/router-status` prints the
same state on demand.

The toast is the only surface available to a plugin here. OpenCode 1.18.4 builds
a user prompt from text and file parts and draws neither a synthetic nor an
ignored one, and a part added to the assistant message would enter the prompt of
every later call in that session.

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

If a stored route no longer exists in the manifest, the next request discards
that route decision and classifies again. If the route ID still exists but its
target changed, pinned and adaptive sessions use the new target for that ID.

## Route manifest

Run the following command to inspect the exact validated manifest used by the
OpenCode plugin:

```bash
./route --manifest --json
```

Schema version 2 defines every route with an `id`, `display_name`, `order`,
OpenCode `target`, all seven routing capabilities, and `acceptedMediaTypes`.
Each routing entry contains an `intent` plus one `route`. Duplicate IDs,
agents, or order values, unknown route references, incomplete targets, and
incomplete capability sets stop startup with a named validation error.

`acceptedMediaTypes` lists lowercase `type/subtype` values plus `type/*`
wildcards:

```json
{
  "id": "codex",
  "acceptedMediaTypes": ["application/pdf", "image/*", "text/plain"]
}
```

The list fails closed. A duplicate value, a value already covered by a wildcard
in the same route, `*/*`, a parameterized value such as
`text/plain; charset=utf-8`, and a list that contradicts `canUseAttachments`
(enabled with an empty list, or disabled with a non-empty one) all stop startup.

The installer generates an OpenCode subagent for every manifest route. This
allows the route count and model targets to change without editing the runtime.
Configs without `schema_version`, and configs with `schema_version: 1`, retain
the four-route legacy expansion.

### Default intent routes

The shipped config contains four intent routes:

| `intent` | Route |
| --- | --- |
| `literal_read_only_no_writing` | MiniMax |
| `translation_simple_brainstorm_docs_or_intermediate_work` | GLM |
| `complex_creative_product_or_architecture` | Claude |
| `review_security_hard_engineering_or_technical_writing` | Codex |

### Project restrictions

A project can place a `.opencode/llm-router.routes.json` file at its root. The
file uses override schema version 1 and may only set capabilities on existing
routes to `false`:

```json
{
  "schema_version": 1,
  "routes": {
    "minimax": {
      "capabilities": {
        "canReadRepository": false
      }
    }
  }
}
```

The project file cannot add routes, change targets, reorder routes, remap
intents, or enable a capability disabled by the global manifest. Invalid
overrides fail closed. After adding, removing, or retargeting a global route,
rerun `opencode/install.sh` and restart OpenCode. Intent, capability, and
project override changes require a restart because the effective manifest is
cached during plugin startup.

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

## Routing layers

The current runtime includes the config-driven manifest. Competence by
difficulty and response-confidence deferral remain future layers.

OpenCode 1.18.4 exposes completed text to a post-response hook, but it does not
provide a safe same-turn contract for replacing the executor after tools may
have run. Sending another model request creates another session message and can
repeat tool calls or project mutations. The third layer stays blocked until the
OpenCode integration can defer or retry a response without duplicating those
effects.
