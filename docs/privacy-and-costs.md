# Privacy and costs

llm-router keeps the routing decision local, but the selected worker still uses
its configured provider. Review every provider's current privacy, retention,
and billing terms before sending sensitive data.

## Data flow

| Component | Receives | Network behavior |
| --- | --- | --- |
| Ollama classifier | Current user request | Calls the configured local Ollama endpoint |
| Ollama compaction summarizer | Sanitized active transcript | Calls the configured local Ollama endpoint |
| MiniMax worker | Approved OpenCode context | Uses the configured MiniMax provider |
| GLM worker | Approved OpenCode context | Uses the configured Z.AI provider |
| Claude worker | Sanitized context, supported attachments, completed task results | Uses Claude through the local Agent SDK and Claude Code executable |
| Codex worker | OpenCode context | Uses the configured OpenAI provider |
| `router-control` | Session command and routing metadata | No LLM request |

The classifier receives the original request because rewriting it before
classification would change the routing signal. It does not receive arbitrary
tool history or repository files.

Before Claude is called, the adapter accepts visible user and assistant text,
supported attachments, completed task or agent results, and a validated
checkpoint. It rejects system text, reasoning, unsupported files, and arbitrary
tool history.

## Credentials

The installer and adapter do not load credentials from files or persist them.
Authentication remains with the normal provider surfaces:

- `MINIMAX_API_KEY` for MiniMax;
- `ZAI_API_KEY` for GLM;
- OpenCode's OpenAI login;
- the authenticated Claude Code executable.

The adapter reads allowed values from the parent process environment and passes
them to a filtered Claude subprocess environment. Runtime, proxy, TLS, and
Claude or Anthropic authentication variables may pass through. Variables for
unrelated providers and exported shell functions do not.

Do not publish:

```bash
opencode debug config
```

It may expand environment values. Inspect agents without printing the complete
configuration:

```bash
opencode debug agent router
opencode debug agent minimax
opencode debug agent glm
opencode debug agent claude
opencode debug agent codex
```

## Cost model

- Local classification adds Ollama compute and no provider API call.
- `auto` classifies every message.
- `adaptive` may reuse the current route when the request does not justify a
  switch, but it still classifies each message.
- `pinned` classifies the first message and reuses the stored worker.
- Compaction summarization calls the local Ollama model once per compaction.
- Worker messages follow the selected provider's normal billing or subscription
  terms.
- Agent mentions and child sessions can create additional worker calls.
- The `restricted` profile can cap steps, tool calls, and child depth. It does
  not guarantee a monetary budget.

The repository does not estimate provider prices because those values change
outside the codebase.

## Sensitive projects

Use a project-level restricted policy when a repository contains risky
operations or long autonomous loops. Project policies can reduce a user's
global permissions, but cannot expand them.

For data that must remain local, configure only local workers and verify their
OpenCode provider behavior. The default route matrix includes remote providers.
