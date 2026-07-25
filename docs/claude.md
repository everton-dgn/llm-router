# Claude through the Agent SDK

Claude Opus 5 is exposed to OpenCode through the local `claude-agent`
provider. The provider implements `LanguageModelV3` and calls `query()` from
`@anthropic-ai/claude-agent-sdk`.

The already installed official executable remains responsible for
authentication. The adapter receives its absolute path through
`pathToClaudeCodeExecutable`, does not search files for credentials, and does
not persist credentials. It filters the parent environment and passes allowed
`ANTHROPIC_` and `CLAUDE_` authentication variables to the subprocess.

The Claude profile travels through configuration rather than the environment.
The installer resolves `CLAUDE_CONFIG_DIR`, falling back to `~/.claude`, and
writes it as `claudeConfigDir`; the adapter exports it to the subprocess.
OpenCode usually starts from a desktop app that never inherits the shell
exports, and without a pinned profile Claude Code reads a directory with no
session and answers every handoff with an expired-login error. The installer
also runs `claude auth status` for that directory and warns when it reports no
active session.

## Reasoning effort

The `effort` option of the `claude-agent` provider sets the reasoning level for
every call. The bundle ships `xhigh`, and the accepted levels are `low`,
`medium`, `high`, `xhigh`, and `max`. A model that does not support the
requested level falls back to the closest one it supports.

```jsonc
"claude-agent": {
  "options": {
    "effort": "xhigh"
  }
}
```

## Flow

```text
OpenCode message
  -> active v2 context
  -> sanitized, bounded projection
  -> typed SDKUserMessage
  -> query() from the Claude Agent SDK
  -> native Claude Code tools
  -> stream and result in the same OpenCode session
```

The main files are:

- [`opencode/providers/claude_agent_provider.mjs`](../opencode/providers/claude_agent_provider.mjs)
- [`opencode/lib/claude_agent.mjs`](../opencode/lib/claude_agent.mjs)
- [`opencode/lib/claude_context.mjs`](../opencode/lib/claude_context.mjs)
- [`opencode/lib/claude_checkpoint.mjs`](../opencode/lib/claude_checkpoint.mjs)

<a id="context-across-models"></a>

## Context across models

OpenCode remains the source of the conversation. The adapter does not persist a
parallel Claude session.

Before the call, the plugin reads `v2.session.context` and builds a typed
sequence:

- historical user messages use `shouldQuery: false`;
- historical assistant turns travel as `type: "assistant"` messages, because
  Claude Code rejects a `user` envelope whose inner role is `assistant`;
- the last message is always the user's current request;
- synthetic text, reasoning, and arbitrary tool history are excluded;
- completed `task` or `agent` results may be included as reported context;
- messages after the current ID are excluded.

This supports the following flow:

```text
Turn 1: GLM investigates the configuration
Turn 2: router selects Claude
Claude turn 2: receives the active conversation, including GLM's visible response
```

The transport limit is 32 MiB, with space reserved for the envelope. The current
message always has priority. Older messages are selected from newest to oldest
and may be dropped to fit. This ceiling measures serialized bytes and does not
estimate tokens.

## Attachments

The current request may include text and the following types:

| Category | MIME types |
| --- | --- |
| Image | `image/gif`, `image/jpeg`, `image/png`, `image/webp` |
| PDF | `application/pdf` |
| Text | `text/plain` |

Images and PDFs accept encoded local data and `http` or `https` URLs. Remote
text must arrive as content, not as an arbitrary URL. File names are treated
only as untrusted metadata and normalized before entering the prompt.

Examples in the composer:

```text
[attach architecture.png]
compare this diagram with the current implementation
```

```text
[attach contract.pdf]
list the obligations and identify contradictory clauses
```

```text
[attach notes.txt]
turn these notes into an implementation plan
```

Invalid base64, mismatched MIME types, URLs that do not use HTTP or HTTPS, and
attachments over budget produce an explicit error. Incompatible historical
attachments are dropped; an incompatible current attachment stops the call.

## Mentions and subtasks

When Claude is the selected worker, the runtime resolves up to four `@agent`
mentions before building the SDK context. Each mention receives an OpenCode
child session with:

- `parentID` pointing to the current conversation;
- the mentioned agent as the executor;
- that agent's effective policy;
- the current request's text and attachments.

Child sessions run in parallel. The runtime waits for each one, reads its latest
valid `assistant` response, and limits the result to 256 KiB. The original
mention is replaced by that completed text. Claude receives the result inside
the current request without pending `agent` metadata.

Router-managed agents such as `router`, `router-control`, `router-auto`,
`router-adaptive`, and `router-manual` cannot be mentioned as subtasks. The
`restricted` profile also applies `max_child_depth` before creating the child
session.

Historical context accepts already completed results from the `task` and
`agent` tools. The text is marked as a reported result instead of a trusted
instruction. Compacted, incomplete, or malformed results are excluded.

Example:

```text
1. The user mentions `@reviewer` together with a PDF.
2. The runtime creates a child session with the text and PDF.
3. `reviewer` completes the analysis.
4. The mention is replaced by the result.
5. Claude receives the request, the PDF, and the completed analysis.
```

## Claude permissions

Each profile produces a distinct contract:

| Profile | Agent SDK contract |
| --- | --- |
| `native` | Keeps `permissionMode: "auto"` without an additional llm-router callback or rules |
| `restricted` | Uses `default` mode, `ask` behavior, and a callback connected to OpenCode permissions |
| `full` | Uses `default` mode and `allow` behavior without per-tool prompts |

When a profile requires control, the provider receives:

- `permissionProfile`, with default behavior and rules by exact tool name;
- `permissionCallback`, for `ask` decisions;
- `permissionTimeoutMs`, which defaults to 30 seconds.

The `canUseTool` callback applies:

| Rule | SDK response |
| --- | --- |
| `allow` | Allows the tool and preserves `toolUseID` |
| `deny` | Denies the tool with a host-controlled message |
| `ask` | Queries the host with cancellation and a timeout |

`ask` fails closed. A missing callback, exception, invalid response,
cancellation, or timeout returns `deny`.

The adapter accepts the SDK modes `acceptEdits`, `auto`, `default`, `dontAsk`,
and `plan`, but rejects combinations that cannot enforce the policy. `dontAsk`
cannot enforce a profile that must query the host.

Even with native tools, the process runs with:

- `safe-mode`;
- `strictMcpConfig`;
- no injected MCP server;
- no local settings source;
- Chrome disabled;
- SDK session persistence disabled;
- an environment filtered to runtime, proxy, TLS, and `ANTHROPIC_` or
  `CLAUDE_` variables.

Local Claude Code plugins, hooks, and skills are not loaded by this transport.

## Compaction and memory

Before a compaction, the local model summarizes only the sanitized transcript.
The result follows a closed schema and is bound to exactly one
`compaction.id`.

The checkpoint is stored in metadata under `llm-router.claude.checkpoint`. On a
future call, it enters the context as a factual recap. If generation, binding,
or validation fails, the provider uses only the active tail and displays a
warning.

This work runs during compaction. It does not follow every response and does not
add an orchestrator turn after the worker.

## Limits and cancellation

| Control | Default |
| --- | ---: |
| Total Claude timeout | 15 minutes |
| Permission timeout | 30 seconds |
| Serialized input | 32 MiB |
| Serialized output | 64 MiB |

The Agent SDK does not expose an enforceable limit equivalent to
`maxOutputTokens`. When OpenCode sends this field, the provider returns an
`unsupported` warning. `maxOutputBytes` provides the transport's actual memory
guard.

The `restricted` profile connects `max_steps` to the Agent SDK's `maxTurns`.
The value must be a positive integer and limits Claude's internal turns. The
hook keeps its own count as a second barrier. `max_tool_calls` is counted in the
internal-tool callback, and `max_child_depth` covers `Task` or `Agent` tools and
child sessions opened by mentions.

Cancelling the message aborts and closes the SDK query. An execution timeout
also aborts the process.
