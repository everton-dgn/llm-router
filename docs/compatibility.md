# Compatibility

llm-router integrates with OpenCode internals, the OpenCode SDK, the Claude
Agent SDK, the Claude Code executable, Ollama, and provider-specific model IDs.
Treat upgrades to any of these surfaces as compatibility changes.

## Supported matrix

| Surface | Supported contract | Validation |
| --- | --- | --- |
| OpenCode | 1.18.4 | Plugin transport and bundle tests |
| `@opencode-ai/plugin` | 1.18.4 | Pinned in `opencode/package.json` |
| `@opencode-ai/sdk` | 1.18.4 | Pinned in `opencode/package.json` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.218 | Pinned in `opencode/package.json` |
| pnpm | 11.16.0 | Pinned in the root `packageManager` field and CI |
| Node.js | 22.22.2, 24.15.0, or a newer supported release | Package engine, dependency engine, and CI |
| Python | 3.11 or newer | `uv` unit tests and benchmark validation |
| macOS | Supported | Local development and installer tests |
| Linux | Supported | Ubuntu CI and POSIX installer tests |
| Windows | Not validated | Use WSL only after running the full local validation |

The routing integration, installer, and deterministic test suite support the
platform matrix above. Executing benchmark assertions that run untrusted Python
or commands currently requires macOS, `/usr/bin/sandbox-exec`, and the Python
executable from a full Xcode installation at
`/Applications/Xcode.app/Contents/Developer/usr/bin/python3`. Configuration
validation and the portable Python unit tests do not require that benchmark
sandbox. Sandbox integration tests run on macOS and are skipped elsewhere.

The Claude Code executable is validated by capabilities instead of a hardcoded
version. During installation, `opencode/install.sh` reads `claude --help` and
requires every flag used by the Agent SDK adapter. Installation stops before
changing files when a required flag is absent.

## OpenCode transport boundary

OpenCode 1.18.4 gives legacy plugins a v1 client while some session operations
used by llm-router exist only in v2. The compatibility helper reuses the
in-process transport from the legacy client to create a v2 SDK client.

This dependency is isolated in `opencode/lib/opencode_transport.mjs`. An
OpenCode upgrade must pass the following before installation:

```bash
node --test tests/router-handoff.test.mjs
bash tests/opencode-bundle.sh
```

Do not remove the compatibility helper based only on a version number. Confirm
that the public plugin client exposes session metadata, context, agent
switching, and updates used by the current implementation.

## Provider identifiers

The default route policy expects these exact IDs:

```text
minimax-coding-plan/MiniMax-M3
zai-coding-plan/glm-5.2
claude-agent/claude-opus-4-8
openai/gpt-5.6-sol
```

Changing an ID affects the routing policy, OpenCode configuration, execution
policy assignments, tests, documentation, and user configuration examples.

## Upgrade checklist

1. Create a branch outside `main`.
2. Change one compatibility surface at a time.
3. Install dependencies with the lockfile unchanged unless the upgrade requires
   a lockfile update.
4. Run `pnpm test`.
5. Run `pnpm test:integration` with Ollama available.
6. Perform `bash opencode/install.sh --dry-run` against a temporary config
   directory.
7. Review the generated diff and update this matrix.
