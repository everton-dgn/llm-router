# Contributing to llm-router

Thanks for helping improve llm-router. This guide describes the supported
development workflow and the checks expected before a pull request.

## Before you start

- Search the existing issues before opening a new one.
- Use a feature request to discuss changes to routing behavior, configuration
  schemas, provider contracts, or other public interfaces.
- Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development requirements

The current development and CI baseline is:

- Node.js 22.22.2, 24.15.0, or a newer supported release
- Python 3.11
- pnpm 11
- `uv`
- Bash
- `jq`
- `trash`

Install repository tooling. The root `postinstall` script configures Lefthook
when the checkout contains `.git`:

```bash
pnpm install --frozen-lockfile
```

Install the pinned OpenCode dependencies without downloading the optional
Claude Code binary:

```bash
pnpm --dir opencode install --frozen-lockfile --no-optional
```

## Making a change

1. Fork the repository and create a focused branch from `main`.
2. Keep the change limited to one concern.
3. Add or update tests for behavior changes.
4. Update user documentation when a command, configuration, or observable
   behavior changes.
5. Use a [Conventional Commit](https://www.conventionalcommits.org/) message.

Commitlint validates commit messages. Lefthook selects focused tests from
staged files before a commit and runs `pnpm test` before a push. Run
`pnpm hooks:install` if lifecycle scripts were disabled during installation.

Do not commit credentials, model outputs containing private data, local
configuration, benchmark workspaces, or generated dependency directories.

## Tests

Run the same deterministic checks used by CI:

```bash
pnpm test
```

The gate includes release-tooling tests, documentation links and JSON examples,
Node.js tests, Python tests, the deterministic smoke test, and the OpenCode
bundle test.

Run the live routing integration separately:

```bash
pnpm test:integration
```

It requires the configured Ollama model and is intentionally excluded from CI.

## Pull requests

A pull request should:

- explain the problem and the chosen solution;
- list user-visible or compatibility effects;
- include the commands used for verification;
- document remaining limitations;
- avoid unrelated formatting or refactoring.

Maintainers may ask for a smaller change when a pull request mixes independent
concerns.

## Contribution license

Unless explicitly stated otherwise, contributions submitted for inclusion in
this project are licensed under the Apache License 2.0, as described in
[LICENSE](LICENSE).
