# Troubleshooting and security

## The router responded instead of the worker

Typical message:

```text
the llm-router handoff plugin is unavailable
```

The primary agent's local model acts as a sentinel. This response indicates that
the hook did not switch the message to a worker.

Check:

```bash
bash opencode/install.sh --dry-run
opencode debug agent router
```

Also confirm that the plugin and libraries are present in the OpenCode
configuration directory.

## The local classifier failed

Test Ollama:

```bash
curl -fsS http://127.0.0.1:11434/api/tags
```

Test the closed contract:

```bash
./route --classify --json "list the project files"
```

The output must be JSON with `schema_version`, `intent`, and `route`. An empty
response, invalid JSON, or unknown route stops the handoff.

## The model did not change in adaptive mode

Check:

```text
/router-status
```

Promotion to a higher route is immediate. A downgrade requires two turns on the
current worker, two consecutive confirmations, and no remaining cooldown. A
short follow-up also preserves the worker when the alternative would be a
downgrade.

To apply every recommendation without hysteresis:

```text
/router-auto
```

## The model did not change in pinned mode

This is expected behavior. `pinned` preserves the session worker. Switch to:

```text
/router-auto
```

or:

```text
/router-adaptive
```

Opening a fork also allows an independent decision because the new branch
receives another `sessionID`.

## The project configuration was rejected

Projects may only restrict. Look for one of these attempts:

- changing `restricted` to `native` or `full`;
- converting `deny` to `ask` or `allow`;
- converting `ask` to `allow`;
- increasing `max_steps`, `max_tool_calls`, or `max_child_depth`;
- using a wildcard in a `models` key;
- including an unknown key.

Validate the format against
[`opencode/llm-router.policy.schema.json`](../opencode/llm-router.policy.schema.json).

## Claude does not appear

Check authentication and the provider:

```bash
claude auth status
opencode models claude-agent
```

The installer also checks whether the executable supports the flags required by
the Agent SDK.

## Claude rejected an attachment or mention

Check the MIME type. The adapter accepts GIF, JPEG, PNG, and WebP images, PDFs,
and plain text.

Other causes:

- invalid base64;
- a declared MIME type that differs from the data URL;
- a URL that does not use HTTP or HTTPS;
- an attachment or current message over the 2 MiB budget;
- more than four `@agent` mentions in one message;
- a mention of `router` or another managed internal agent;
- a child session over `max_child_depth`;
- a subtask without a text response or with a result over 256 KiB.

The runtime resolves mentions in child sessions before calling Claude. If the
adapter reports that it still received an `agent attachment`, confirm that the
plugin and `router_control.mjs` came from the same version. See
[mentions and subtasks](claude.md#mentions-and-subtasks).

## Claude requested permission and stopped

In the `restricted` profile, an `ask` rule requires a host callback. The adapter
denies the request after 30 seconds, or earlier if an error, cancellation, or
missing callback occurs.

Check the status:

```text
/router-status
```

To use the provider's normal behavior:

```text
/router-native
```

To allow all session tools without per-tool confirmation:

```text
/router-full
```

Use `/router-restricted` when you want explicit allow, ask, and deny rules
while diagnosing a permission problem.

## Long loop with a small model

Use:

```text
/router-adaptive
/router-restricted
```

Then lower the limits in the project:

```json
{
  "schemaVersion": 1,
  "defaultProfile": "restricted",
  "models": {
    "minimax-coding-plan/MiniMax-M3": "restricted",
    "zai-coding-plan/glm-5.2": "restricted",
    "claude-agent/claude-opus-4-8": "restricted",
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

`adaptive` allows promotion to a more capable worker when the request becomes
difficult. `restricted` prevents that switch from expanding tools as a side
effect.

## Small worker with limited memory

The local 4B model only classifies and exits. It does not retain conversation
context, execute project tools, or wait for the worker to finish.

Context remains in OpenCode. Each worker receives the active conversation
according to its provider. The local classifier exits after the decision and
does not need long-term memory or a later coordination turn.

## An upgrade changed managed files

Run:

```bash
bash opencode/install.sh --dry-run
```

Managed files are backed up before replacement. The installer creates
`llm-router.policy.json` once and preserves its contents during upgrades.
Identical reinstallations create no new backup.

## The uninstall token was rejected

An uninstall token is bound to the preview and to fingerprints of the affected
files. It is rejected when it is invalid, belongs to another preview, or the
configuration changed after it was issued.

Run a fresh preview:

```text
/router-uninstall
```

Review the new plan, then apply the token printed by that response:

```text
/router-uninstall <token>
```

If the uninstall succeeds, note the recovery path in the response and restart
OpenCode. For legacy installations, the result may list ambiguous files or
shared entries that were preserved for manual review. See
[uninstall and rollback](uninstall.md).

## Regression tests

```bash
bash tests/smoke.sh
bash tests/routing-eval.sh
bash tests/opencode-bundle.sh
node --test \
  tests/router-handoff.test.mjs \
  tests/execution-policy.test.mjs \
  tests/router-control.test.mjs \
  tests/claude-agent.test.mjs \
  tests/claude-agent-provider.test.mjs \
  tests/repo-query.test.mjs
```
