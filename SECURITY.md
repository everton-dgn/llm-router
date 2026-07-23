# Security policy

## Supported versions

The current stable line and `main` receive security fixes. Older releases may
require an upgrade.

| Version | Supported |
| --- | --- |
| `1.0.x` | Yes |
| `main` | Yes |
| Older releases | No |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use
[GitHub private vulnerability reporting](https://github.com/everton-dgn/llm-router/security/advisories/new)
and include:

- the affected component and version or commit;
- the impact and realistic attack scenario;
- reproduction steps or a minimal proof of concept;
- any known mitigation;
- whether the report may be shared with another maintainer.

Remove access tokens, credentials, personal data, and unrelated private
information from the report.

You should receive an acknowledgement within five business days and an initial
assessment within ten business days. Timelines for a fix and disclosure depend
on severity, affected providers, and coordination with upstream projects.

## Scope

The following are in scope:

- the router CLI and its structured output;
- OpenCode plugins, providers, tools, and installer;
- execution-policy enforcement and configuration parsing;
- context projection, attachment handling, and session metadata;
- repository-query path boundaries;
- release and CI automation maintained in this repository.

Reports that only concern an upstream model, provider, OpenCode, Ollama, or
Claude Code should be sent to that project's security channel unless
llm-router creates or increases the impact.

## Research guidelines

Act in good faith, use your own data and accounts, avoid service disruption,
and stop testing if you encounter data that belongs to another person. Allow a
reasonable remediation period before public disclosure.
