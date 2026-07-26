# Configuration reference

Reference for `config.json` and for the project override. Read it when you are
adding, removing, or retargeting a route, or when you need the exact shape the
classifier must return.

## Where each decision lives

| Decision | File | Applies after |
| --- | --- | --- |
| Route IDs, display names, cost order, OpenCode targets | `config.json` | Rerunning `bash setup.sh` and restarting OpenCode |
| Intent to route mapping | `config.json` | Restarting OpenCode |
| Route capabilities and accepted media types | `config.json` | Restarting OpenCode |
| Reducing capabilities for one project | `.opencode/llm-router.routes.json` | Restarting OpenCode |
| Tools, permissions, and turn limits | `llm-router.policy.json` | See [execution policies](execution-policies.md) |

## Routing entries

`config.json` schema 2 is the source of truth for route IDs, display names,
cost order, OpenCode targets, the seven route capabilities, the accepted
media types, and intent mappings. Each routing entry declares one `intent` and
one `route`:

```json
{
  "intent": "translation_simple_brainstorm_docs_or_intermediate_work",
  "route": "glm"
}
```

The runtime does not assume a fixed route count or fixed model IDs. Inspect the
normalized schema 2 manifest without starting Ollama:

```bash
./route --manifest --json
```

The installer validates this manifest and generates the required OpenCode agent
and provider model entries. A version 1 config, identified by a missing
`schema_version` or `schema_version: 1`, expands to the four legacy routes.
Version 2 configs may add, remove, or retarget routes. Both versions normalize
to schema 2 and must pass the complete validation.

## Classifier output contract

Successful classifier output uses exact schema 1 keys:

```json
{
  "schema_version": 1,
  "intent": "translation_simple_brainstorm_docs_or_intermediate_work",
  "route": "glm"
}
```

Classification failures also use schema 1 and write an exact error object to
standard error:

```json
{
  "schema_version": 1,
  "error": {
    "code": "invalid_classifier_response",
    "message": "classifier did not return a valid route"
  }
}
```

## Project override

A project may reduce route eligibility in
`.opencode/llm-router.routes.json`. The override can only set existing
capabilities to `false`; route IDs, order, targets, and intent mappings stay
global. For example:

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

## When changes take effect

The manifest is cached when the plugin starts. After adding, removing, or
retargeting a route in `config.json`, run `bash setup.sh` again and restart
OpenCode. Intent and capability changes in `config.json`, plus project override
changes, require an OpenCode restart.

Route capabilities are an eligibility filter applied after classification. They
never grant or remove OpenCode tools; that is what
[execution policies](execution-policies.md) control. Attachments pass through
the same filter, and [attachments](routing-modes.md#attachments) documents
every outcome.
