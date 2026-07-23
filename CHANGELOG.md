# Changelog

Notable user-visible changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-07-23

### Added

- Route OpenCode messages to MiniMax M3, GLM 5.2, Claude Opus 4.8, or GPT-5.6 Sol without leaving the current conversation.
- Choose between per-message `auto`, hysteresis-based `adaptive`, and session-pinned routing.
- Control tools independently through the `native`, `restricted`, and `full` execution profiles.
- Run Claude through the official Agent SDK with bounded conversation history, supported attachments, completed child-agent results, and verified compaction checkpoints.
- Install the OpenCode bundle with preflight validation, recoverable backups, preserved user configuration and policy, hash-verified legacy cleanup, and idempotent updates.
- Validate routing, policies, provider transports, installation, benchmarks, and release tooling with deterministic test suites.
- Prepare public contribution, security, support, CI, documentation, SemVer, changelog, and GitHub Release workflows.
