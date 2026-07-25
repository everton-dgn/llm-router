import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import test from "node:test"
import { promisify } from "node:util"

import {
  applyRouteManifestOverride,
  LEGACY_ROUTE_MANIFEST,
  MAX_ROUTE_MANIFEST_BYTES,
  normalizeAttachmentMediaType,
  normalizeRouteManifest,
  parseRouteManifestOverride,
  parseRouteManifest,
  ROUTE_CAPABILITY_KEYS,
  routeAcceptsMediaType,
  routeManifestEntry,
} from "../opencode/lib/route_manifest.mjs"
import {
  attachmentMediaTypes,
  enforceMediaCompatibleRoute,
  enforceMinimumRoute,
  NO_COMPATIBLE_ROUTE_ERROR_CODE,
  minimumCompatibleRoute,
  routeCapabilities,
  routeSupportsRequest,
  routeTarget,
  routeTargets,
  unsupportedRouteMediaTypes,
} from "../opencode/lib/routing_policy.mjs"
import { parseClassifierResult } from "../opencode/lib/route_contract.mjs"
import {
  readRoutingState,
  ROUTING_STATE_METADATA_KEY,
  transitionRoutingState,
} from "../opencode/lib/adaptive_routing.mjs"

const execFileAsync = promisify(execFile)

function capabilities(value = true) {
  return Object.fromEntries(ROUTE_CAPABILITY_KEYS.map((key) => [key, value]))
}

function route(id, order) {
  return {
    id,
    display_name: id.toUpperCase(),
    order,
    target: {
      agent: `${id}-agent`,
      providerID: `${id}-provider`,
      modelID: `${id}-model`,
    },
    capabilities: capabilities(),
    acceptedMediaTypes: ["application/pdf", "image/*"],
  }
}

function withoutAttachments(entry) {
  entry.capabilities.canUseAttachments = false
  entry.acceptedMediaTypes = []
  return entry
}

test("expands a schema v1 config into the four legacy routes", () => {
  const manifest = normalizeRouteManifest({
    routes: [
      { name: "claude", display_name: "Custom Claude label" },
      { name: "codex", display_name: "Custom Codex label" },
      { name: "minimax", display_name: "Custom MiniMax label" },
      { name: "glm", display_name: "Custom GLM label" },
    ],
    routing: [
      { intent: "literal", route: "minimax" },
      { intent: "general", route: "glm" },
      { intent: "planning", route: "claude" },
      { intent: "review", route: "codex" },
    ],
  })

  assert.equal(manifest.schema_version, 2)
  assert.equal(manifest.routing[0].route, "minimax")
  assert.deepEqual(
    manifest.routes.map(({ id, order }) => ({ id, order })),
    [
      { id: "minimax", order: 0 },
      { id: "glm", order: 1 },
      { id: "claude", order: 2 },
      { id: "codex", order: 3 },
    ],
  )
  assert.equal(routeManifestEntry(manifest, "claude").display_name, "Custom Claude label")
  assert.deepEqual(
    routeManifestEntry(manifest, "minimax").target,
    LEGACY_ROUTE_MANIFEST.routes[0].target,
  )
})

test("rejects a schema v1 routing entry with no legacy route", () => {
  assert.throws(
    () => normalizeRouteManifest({
      routes: [],
      routing: [{ intent: "new", route: "custom" }],
    }),
    /references unknown route: custom/,
  )
})

test("normalizes a schema v2 manifest", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("expensive", 10), route("cheap", 0)],
    routing: [{ intent: "default", route: "cheap", help: "Default route" }],
  })

  assert.equal(manifest.schema_version, 2)
  assert.deepEqual(manifest.routes.map(({ id }) => id), ["cheap", "expensive"])
  assert.equal(manifest.routing[0].route, "cheap")
  assert.equal(Object.isFrozen(manifest), true)
  assert.equal(Object.isFrozen(manifest.routes), true)
  assert.equal(Object.isFrozen(manifest.routes[0].target), true)
  assert.equal(Object.isFrozen(manifest.routes[0].capabilities), true)
})

test("rejects incomplete capabilities and duplicate orders", () => {
  const incomplete = route("incomplete", 0)
  delete incomplete.capabilities.canUseAttachments
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [incomplete],
      routing: [{ intent: "default", route: "incomplete" }],
    }),
    /capabilities must contain exactly/,
  )

  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [route("first", 0), route("second", 0)],
      routing: [{ intent: "default", route: "first" }],
    }),
    /duplicate route order: 0/,
  )
})

test("requires display names and rejects reserved router target agents", () => {
  const missingDisplayName = route("missing-label", 0)
  delete missingDisplayName.display_name
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [missingDisplayName],
      routing: [{ intent: "default", route: "missing-label" }],
    }),
    /display_name must be a non-empty string/,
  )

  const emptyDisplayName = route("empty-label", 0)
  emptyDisplayName.display_name = " "
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [emptyDisplayName],
      routing: [{ intent: "default", route: "empty-label" }],
    }),
    /display_name must be a non-empty string/,
  )

  for (const reservedAgent of [
    "router",
    "router-auto",
    "router-manual",
    "router-adaptive",
    "router-control",
  ]) {
    const reserved = route("reserved", 0)
    reserved.target.agent = reservedAgent
    assert.throws(
      () => normalizeRouteManifest({
        schema_version: 2,
        routes: [reserved],
        routing: [{ intent: "default", route: "reserved" }],
      }),
      /target agent is reserved/,
    )
  }
})

test("rejects an explicit null schema version instead of treating it as legacy", () => {
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: null,
      routes: [],
      routing: [{ intent: "default", route: "minimax" }],
    }),
    /unsupported route manifest schema_version: null/,
  )
})

test("revalidates the route script manifest output with the runtime parser", async () => {
  const { stdout } = await execFileAsync("./route", ["--manifest", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: MAX_ROUTE_MANIFEST_BYTES,
  })
  const manifest = parseRouteManifest(stdout)

  assert.deepEqual(manifest.routes.map(({ id }) => id), [
    "minimax",
    "glm",
    "claude",
    "codex",
  ])
})

test("rejects malformed and oversized runtime manifest output", () => {
  assert.throws(() => parseRouteManifest("not-json"), /invalid JSON/)
  assert.throws(
    () => parseRouteManifest(`"${"x".repeat(MAX_ROUTE_MANIFEST_BYTES)}"`),
    /exceeds 262144 UTF-8 bytes/,
  )
})

test("routing policy derives targets and capabilities from an injected manifest", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("custom", 0)],
    routing: [{ intent: "default", route: "custom" }],
  })

  assert.deepEqual(routeTarget("custom", manifest), {
    agent: "custom-agent",
    providerID: "custom-provider",
    modelID: "custom-model",
  })
  assert.deepEqual(routeTargets(manifest), {
    custom: {
      agent: "custom-agent",
      providerID: "custom-provider",
      modelID: "custom-model",
    },
  })
  assert.deepEqual(routeCapabilities(manifest), {
    custom: capabilities(),
  })
})

test("classifier and adaptive routing use ids and order from the injected manifest", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("large", 20), route("small", 10)],
    routing: [
      { intent: "small_work", route: "small" },
      { intent: "large_work", route: "large" },
    ],
  })
  const classified = parseClassifierResult(
    JSON.stringify({
      schema_version: 1,
      intent: "large_work",
      route: "large",
    }),
    manifest,
  )
  assert.equal(classified.route, "large")
  assert.throws(
    () => parseClassifierResult(
      JSON.stringify({
        schema_version: 1,
        intent: "unknown",
        route: "missing",
      }),
      manifest,
    ),
    /invalid route: missing/,
  )
  assert.throws(
    () => parseClassifierResult(
      JSON.stringify({
        schema_version: 1,
        intent: "small_work",
        route: "large",
      }),
      manifest,
    ),
    /intent small_work must map to route small/,
  )
  const next = transitionRoutingState({
    state: {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "adaptive",
      currentRoute: "small",
      turnsOnCurrent: 3,
      cooldownTurnsRemaining: 0,
    },
    sessionID: "session-1",
    mode: "adaptive",
    recommendedRoute: "large",
    manifest,
  })
  assert.equal(next.currentRoute, "large")
})

test("adaptive routing immediately leaves a route incompatible with the current request", () => {
  const current = withoutAttachments(route("current", 10))
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("recommended", 0), current],
    routing: [
      { intent: "attachment_work", route: "recommended" },
      { intent: "other_work", route: "current" },
    ],
  })

  const next = transitionRoutingState({
    state: {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "adaptive",
      currentRoute: "current",
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: 2,
    },
    sessionID: "session-1",
    mode: "adaptive",
    recommendedRoute: "recommended",
    request: "",
    requirements: { hasAttachments: true },
    manifest,
  })

  assert.equal(next.currentRoute, "recommended")
  assert.equal(next.pendingDowngrade, undefined)
})

test("a custom intent may select a literal-only route without a hardcoded intent id", () => {
  const literal = route("literal", 0)
  literal.capabilities.canHandleNonLiteralText = false
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [literal, route("general", 1)],
    routing: [{ intent: "custom_exact_lookup", route: "literal" }],
  })
  const classified = parseClassifierResult(
    JSON.stringify({
      schema_version: 1,
      intent: "custom_exact_lookup",
      route: "literal",
    }),
    manifest,
  )

  assert.equal(
    enforceMinimumRoute(classified.route, "qual maior arquivo do repo?", {}, manifest),
    "literal",
  )
})

test("minimum route promotion starts above the selected order and fails closed", () => {
  const selected = withoutAttachments(route("selected", 10))
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("lower", 0), selected, route("higher", 20)],
    routing: [{ intent: "default", route: "selected" }],
  })

  assert.equal(
    enforceMinimumRoute(
      "selected",
      "",
      { hasAttachments: true },
      manifest,
    ),
    "higher",
  )

  const noCompatibleRoute = withoutAttachments(route("only", 0))
  const noCompatible = normalizeRouteManifest({
    schema_version: 2,
    routes: [noCompatibleRoute],
    routing: [{ intent: "default", route: "only" }],
  })
  assert.throws(
    () => enforceMinimumRoute("only", "", { hasAttachments: true }, noCompatible),
    (error) => (
      /no compatible route available above: only/.test(error.message)
      && error.code === NO_COMPATIBLE_ROUTE_ERROR_CODE
    ),
  )
})

// The attachments alone are routable here, so naming this a media rejection
// would blame the wrong cause. It still stops the message, and the plugin needs
// a code to explain the stop instead of failing silently.
test("a capability gap with routable attachments carries its own error code", () => {
  const literalOnly = (id, order, mediaTypes) => ({
    ...route(id, order),
    capabilities: { ...route(id, order).capabilities, canHandleNonLiteralText: false },
    acceptedMediaTypes: mediaTypes,
  })

  const selectedAcceptsMedia = normalizeRouteManifest({
    schema_version: 2,
    routes: [literalOnly("literal", 0, ["video/mp4"])],
    routing: [{ intent: "default", route: "literal" }],
  })
  assert.throws(
    () => enforceMinimumRoute(
      "literal",
      "brainstorm five ideas",
      { hasAttachments: true, attachmentMediaTypes: ["video/mp4"] },
      selectedAcceptsMedia,
    ),
    (error) => error.code === NO_COMPATIBLE_ROUTE_ERROR_CODE,
  )

  const anotherRouteAcceptsMedia = normalizeRouteManifest({
    schema_version: 2,
    routes: [
      literalOnly("literal", 0, ["image/png"]),
      literalOnly("video", 1, ["video/mp4"]),
    ],
    routing: [{ intent: "default", route: "literal" }],
  })
  assert.throws(
    () => enforceMinimumRoute(
      "literal",
      "brainstorm five ideas",
      { hasAttachments: true, attachmentMediaTypes: ["video/mp4"] },
      anotherRouteAcceptsMedia,
    ),
    (error) => (
      error.code === NO_COMPATIBLE_ROUTE_ERROR_CODE
      && error.mediaTypes.includes("video/mp4")
    ),
  )
})

test("removed session routes reclassify without changing the stored routing mode", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("current", 0)],
    routing: [{ intent: "default", route: "current" }],
  })
  const metadata = {
    [ROUTING_STATE_METADATA_KEY]: {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "pinned",
      currentRoute: "removed",
      turnsOnCurrent: 4,
      cooldownTurnsRemaining: 0,
      pendingDowngrade: { route: "also-removed", confirmations: 1 },
    },
  }
  const migrated = readRoutingState(metadata, "session-1", manifest)

  assert.equal(migrated.mode, "pinned")
  assert.equal(migrated.currentRoute, undefined)
  assert.equal(migrated.pendingDowngrade, undefined)
  assert.deepEqual(
    transitionRoutingState({
      state: migrated,
      sessionID: "session-1",
      mode: "pinned",
      recommendedRoute: "current",
      manifest,
    }),
    {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "pinned",
      currentRoute: "current",
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: 0,
    },
  )
})

test("a pinned route id uses its current target after a manifest change", () => {
  const changed = route("stable", 0)
  changed.target.modelID = "replacement-model"
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [changed],
    routing: [{ intent: "default", route: "stable" }],
  })
  const state = readRoutingState({
    [ROUTING_STATE_METADATA_KEY]: {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "pinned",
      currentRoute: "stable",
      turnsOnCurrent: 2,
      cooldownTurnsRemaining: 0,
    },
  }, "session-1", manifest)

  assert.equal(state.currentRoute, "stable")
  assert.equal(routeTarget(state.currentRoute, manifest).modelID, "replacement-model")
})

test("project overrides may only reduce route capabilities", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("worker", 0)],
    routing: [{ intent: "default", route: "worker" }],
  })
  const restricted = applyRouteManifestOverride(manifest, {
    schema_version: 1,
    routes: {
      worker: {
        capabilities: {
          canExecuteCommands: false,
          canMutateProject: false,
        },
      },
    },
  })

  assert.equal(routeManifestEntry(restricted, "worker").capabilities.canExecuteCommands, false)
  assert.equal(routeManifestEntry(restricted, "worker").capabilities.canMutateProject, false)
  assert.equal(routeManifestEntry(restricted, "worker").capabilities.canReadRepository, true)
  assert.throws(
    () => applyRouteManifestOverride(manifest, {
      schema_version: 1,
      routes: {
        worker: { capabilities: { canExecuteCommands: true } },
      },
    }),
    /may only set capabilities to false: canExecuteCommands/,
  )
  assert.throws(
    () => applyRouteManifestOverride(manifest, {
      schema_version: 1,
      routes: {
        missing: { capabilities: { canExecuteCommands: false } },
      },
    }),
    /contains unknown routes: missing/,
  )
})

test("project override parsing fails closed on malformed or expanded fields", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("worker", 0)],
    routing: [{ intent: "default", route: "worker" }],
  })
  assert.throws(
    () => parseRouteManifestOverride("not-json", manifest, "test override"),
    /test override is invalid JSON/,
  )
  assert.throws(
    () => applyRouteManifestOverride(manifest, {
      schema_version: 1,
      routes: {
        worker: {
          capabilities: { canExecuteCommands: false },
          order: 99,
        },
      },
    }),
    /route worker must contain exactly capabilities/,
  )
})

test("normalizes accepted media types and matches exact values and wildcards", () => {
  const images = route("images", 0)
  images.acceptedMediaTypes = ["image/*", "application/pdf"]
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [images],
    routing: [{ intent: "default", route: "images" }],
  })
  const entry = routeManifestEntry(manifest, "images")

  assert.deepEqual(entry.acceptedMediaTypes, ["image/*", "application/pdf"])
  assert.equal(Object.isFrozen(entry.acceptedMediaTypes), true)
  assert.equal(routeAcceptsMediaType(entry, "image/png"), true)
  assert.equal(routeAcceptsMediaType(entry, "image/svg+xml"), true)
  assert.equal(routeAcceptsMediaType(entry, "application/pdf"), true)
  assert.equal(routeAcceptsMediaType(entry, "video/mp4"), false)
  assert.equal(routeAcceptsMediaType(entry, "application/octet-stream"), false)
})

test("normalizes an attachment media type and rejects wildcard attachments", () => {
  assert.equal(normalizeAttachmentMediaType("IMAGE/PNG"), "image/png")
  assert.equal(normalizeAttachmentMediaType(" text/plain; charset=utf-8 "), "text/plain")
  assert.equal(normalizeAttachmentMediaType("image/*"), "")
  assert.equal(normalizeAttachmentMediaType("image"), "")
  assert.equal(normalizeAttachmentMediaType("*/*"), "")
  assert.equal(normalizeAttachmentMediaType(undefined), "")
  assert.equal(normalizeAttachmentMediaType(`image/${"p".repeat(300)}`), "")
})

for (const [label, acceptedMediaTypes, expected] of [
  ["a malformed value", ["image"], /invalid accepted media type: image/],
  ["an uppercase value", ["Image/PNG"], /invalid accepted media type: Image\/PNG/],
  ["a parameterized value", ["text/plain; charset=utf-8"], /invalid accepted media type/],
  ["a global wildcard", ["*/*"], /invalid accepted media type: \*\/\*/],
  ["a non-string value", [7], /invalid accepted media type: 7/],
  ["a duplicate value", ["image/png", "image/png"], /duplicate accepted media type: image\/png/],
  [
    "a value already covered by a wildcard",
    ["image/*", "image/png"],
    /image\/png is already covered by image\/\*/,
  ],
]) {
  test(`rejects ${label} in acceptedMediaTypes`, () => {
    const entry = route("worker", 0)
    entry.acceptedMediaTypes = acceptedMediaTypes
    assert.throws(
      () => normalizeRouteManifest({
        schema_version: 2,
        routes: [entry],
        routing: [{ intent: "default", route: "worker" }],
      }),
      expected,
    )
  })
}

test("rejects a manifest whose attachment capability contradicts its media types", () => {
  const missingTypes = route("missing-types", 0)
  missingTypes.acceptedMediaTypes = []
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [missingTypes],
      routing: [{ intent: "default", route: "missing-types" }],
    }),
    /enables canUseAttachments without any accepted media type/,
  )

  const undeclared = route("undeclared", 0)
  delete undeclared.acceptedMediaTypes
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [undeclared],
      routing: [{ intent: "default", route: "undeclared" }],
    }),
    /enables canUseAttachments without any accepted media type/,
  )

  const disabled = route("disabled", 0)
  disabled.capabilities.canUseAttachments = false
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [disabled],
      routing: [{ intent: "default", route: "disabled" }],
    }),
    /declares accepted media types while canUseAttachments is false/,
  )

  const notAnArray = route("not-an-array", 0)
  notAnArray.acceptedMediaTypes = "image/png"
  assert.throws(
    () => normalizeRouteManifest({
      schema_version: 2,
      routes: [notAnArray],
      routing: [{ intent: "default", route: "not-an-array" }],
    }),
    /acceptedMediaTypes must be an array of media types/,
  )
})

test("a project override that disables attachments also drops its media types", () => {
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [route("worker", 0)],
    routing: [{ intent: "default", route: "worker" }],
  })
  const restricted = applyRouteManifestOverride(manifest, {
    schema_version: 1,
    routes: { worker: { capabilities: { canUseAttachments: false } } },
  })
  const entry = routeManifestEntry(restricted, "worker")

  assert.equal(entry.capabilities.canUseAttachments, false)
  assert.deepEqual(entry.acceptedMediaTypes, [])
  assert.equal(routeAcceptsMediaType(entry, "image/png"), false)
})

test("the route script manifest declares the media types of every shipped route", async () => {
  const { stdout } = await execFileAsync("./route", ["--manifest", "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    maxBuffer: MAX_ROUTE_MANIFEST_BYTES,
  })
  const manifest = parseRouteManifest(stdout)

  assert.deepEqual(
    manifest.routes.map(({ id, acceptedMediaTypes }) => [id, acceptedMediaTypes]),
    [
      ["minimax", ["image/*", "text/plain", "video/*"]],
      ["glm", []],
      ["claude", [
        "application/pdf",
        "image/gif",
        "image/jpeg",
        "image/png",
        "image/webp",
        "text/plain",
      ]],
      ["codex", ["application/pdf", "image/*", "text/plain"]],
    ],
  )
})

test("route selection keeps a route that accepts every attachment", () => {
  const options = {
    hasAttachments: true,
    attachmentMediaTypes: ["image/png", "application/pdf"],
  }

  assert.equal(routeSupportsRequest("claude", "analise o anexo", options), true)
  assert.equal(routeSupportsRequest("glm", "analise o anexo", options), false)
  assert.equal(
    enforceMinimumRoute("claude", "analise o anexo", options),
    "claude",
  )
  assert.equal(
    enforceMinimumRoute("glm", "analise o anexo", options),
    "claude",
  )
  assert.deepEqual(
    unsupportedRouteMediaTypes("glm", ["image/png", "application/pdf"]),
    ["image/png", "application/pdf"],
  )
  assert.deepEqual(unsupportedRouteMediaTypes("claude", ["image/png"]), [])
})

test("an unknown attachment media type only reaches a route that declares it", () => {
  assert.deepEqual(attachmentMediaTypes(["", undefined, "image/png", "IMAGE/png"]), [
    "application/octet-stream",
    "image/png",
  ])
  assert.throws(
    () => enforceMinimumRoute(
      "claude",
      "analise o anexo",
      { hasAttachments: true, attachmentMediaTypes: [""] },
    ),
    /no route accepts the attached media types: application\/octet-stream/,
  )

  const permissive = route("permissive", 0)
  permissive.acceptedMediaTypes = ["application/octet-stream"]
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [permissive],
    routing: [{ intent: "default", route: "permissive" }],
  })
  assert.equal(
    enforceMinimumRoute(
      "permissive",
      "analise o anexo",
      { hasAttachments: true, attachmentMediaTypes: ["unknown"] },
      manifest,
    ),
    "permissive",
  )
})

test("media incompatibility may fall back to a cheaper route and otherwise fails closed", () => {
  const video = route("video", 0)
  video.acceptedMediaTypes = ["video/mp4"]
  const text = route("text", 1)
  text.acceptedMediaTypes = ["text/plain"]
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [video, text],
    routing: [{ intent: "default", route: "text" }],
  })

  assert.equal(
    enforceMinimumRoute(
      "text",
      "analise o anexo",
      { hasAttachments: true, attachmentMediaTypes: ["video/mp4"] },
      manifest,
    ),
    "video",
  )
  assert.equal(
    enforceMediaCompatibleRoute("text", ["video/mp4"], manifest),
    "video",
  )
  assert.throws(
    () => enforceMinimumRoute(
      "text",
      "analise o anexo",
      { hasAttachments: true, attachmentMediaTypes: ["audio/mpeg"] },
      manifest,
    ),
    /no route accepts the attached media types: audio\/mpeg/,
  )
  assert.throws(
    () => enforceMediaCompatibleRoute("text", ["video/mp4", "text/plain"], manifest),
    /no single route accepts every attached media type: video\/mp4, text\/plain/,
  )
  assert.throws(
    () => minimumCompatibleRoute(
      "",
      { hasAttachments: true, attachmentMediaTypes: ["audio/mpeg"] },
      manifest,
    ),
    /no route accepts the attached media types: audio\/mpeg/,
  )

  try {
    enforceMediaCompatibleRoute("text", ["audio/mpeg"], manifest)
    assert.fail("an unsupported media type must stop routing")
  } catch (error) {
    assert.equal(error.code, "unsupported_media_type")
    assert.deepEqual(error.mediaTypes, ["audio/mpeg"])
  }
})

test("adaptive routing leaves a route that cannot read the attachment immediately", () => {
  const current = route("current", 10)
  current.acceptedMediaTypes = ["text/plain"]
  const recommended = route("recommended", 0)
  recommended.acceptedMediaTypes = ["image/png"]
  const manifest = normalizeRouteManifest({
    schema_version: 2,
    routes: [recommended, current],
    routing: [
      { intent: "image_work", route: "recommended" },
      { intent: "other_work", route: "current" },
    ],
  })

  const next = transitionRoutingState({
    state: {
      schemaVersion: 1,
      sessionID: "session-1",
      mode: "adaptive",
      currentRoute: "current",
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: 3,
      pendingDowngrade: { route: "recommended", confirmations: 1 },
    },
    sessionID: "session-1",
    mode: "adaptive",
    recommendedRoute: "recommended",
    request: "analise a imagem",
    requirements: {
      hasAttachments: true,
      attachmentMediaTypes: ["image/png"],
    },
    manifest,
  })

  assert.equal(next.currentRoute, "recommended")
  assert.equal(next.pendingDowngrade, undefined)
})

for (const routeCount of [1, 5, 8]) {
  test(`supports routing contracts with ${routeCount} configured route(s)`, () => {
    const routes = Array.from({ length: routeCount }, (_, index) => {
      const entry = route(`route-${index}`, index)
      return index === routeCount - 1 ? entry : withoutAttachments(entry)
    })
    const first = routes[0].id
    const last = routes.at(-1).id
    const manifest = normalizeRouteManifest({
      schema_version: 2,
      routes,
      routing: [{ intent: "default", route: first }],
    })

    assert.equal(
      parseClassifierResult(
        JSON.stringify({
          schema_version: 1,
          intent: "default",
          route: first,
        }),
        manifest,
      ).route,
      first,
    )
    assert.equal(routeTarget(last, manifest).agent, `${last}-agent`)
    assert.equal(
      enforceMinimumRoute(first, "", { hasAttachments: true }, manifest),
      last,
    )
    assert.equal(
      transitionRoutingState({
        state: {
          schemaVersion: 1,
          sessionID: "session-1",
          mode: "adaptive",
          currentRoute: first,
          turnsOnCurrent: 2,
          cooldownTurnsRemaining: 0,
        },
        sessionID: "session-1",
        mode: "adaptive",
        recommendedRoute: last,
        manifest,
      }).currentRoute,
      last,
    )

    const restricted = applyRouteManifestOverride(manifest, {
      schema_version: 1,
      routes: {
        [last]: { capabilities: { canExecuteCommands: false } },
      },
    })
    assert.equal(
      routeManifestEntry(restricted, last).capabilities.canExecuteCommands,
      false,
    )
  })
}
