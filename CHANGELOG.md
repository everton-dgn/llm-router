# Changelog

Notable user-visible changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## 1.1.2 - 2026-07-25

### Fixed
- **changelog:** Keep generated release notes from freezing the release flow
- **ci:** Keep release notes sync on manual dispatch and grant actions read
- **release:** Stop the approval-required run for release pull requests

## 1.1.1 - 2026-07-25

### Fixed
- **opencode:** Drop redundant control toast and report axis changes

## 1.1.0 - 2026-07-25

### Added
- **opencode:** Report the routing state and harden the installer
- **router:** Drive routes and attachment support from the manifest

### Fixed
- **install:** Decide the provider lookup by status, not by error wording
- **router:** Address review findings on routing, install and tests
- **claude:** Replay assistant history and pin the signed-in profile
- **router:** Keep the non-literal veto as defense in depth
- **router:** Trust classifier intent for literal read-only routing

## 1.0.0 - 2026-07-23

### Added

- Route OpenCode messages to MiniMax M3, GLM 5.2, Claude Opus 4.8, or GPT-5.6 Sol without leaving the current conversation.
- Choose between per-message `auto`, hysteresis-based `adaptive`, and session-pinned routing.
- Control tools independently through the `native`, `restricted`, and `full` execution profiles.
- Run Claude through the official Agent SDK with bounded conversation history, supported attachments, completed child-agent results, and verified compaction checkpoints.
- Install the OpenCode bundle with preflight validation, recoverable backups, preserved user configuration and policy, hash-verified legacy cleanup, and idempotent updates.
- Validate routing, policies, provider transports, installation, benchmarks, and release tooling with deterministic test suites.
- Prepare public contribution, security, support, CI, documentation, SemVer, changelog, and GitHub Release workflows.



