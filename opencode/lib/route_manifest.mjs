export const ROUTE_MANIFEST_SCHEMA_VERSION = 2
export const MAX_ROUTE_MANIFEST_BYTES = 256 * 1024
export const ROUTE_MANIFEST_OVERRIDE_SCHEMA_VERSION = 1
export const MAX_ROUTE_MANIFEST_OVERRIDE_BYTES = 64 * 1024

export const ROUTE_CAPABILITY_KEYS = Object.freeze([
  "canExecuteCommands",
  "canHandleNonLiteralText",
  "canMutateProject",
  "canReadRepository",
  "canUseAgentMentions",
  "canUseAttachments",
  "canUseExternalTools",
])

export const RESERVED_ROUTER_AGENTS = Object.freeze([
  "router",
  "router-auto",
  "router-manual",
  "router-adaptive",
  "router-control",
])

const MEDIA_TYPE_WILDCARD_SUFFIX = "/*"
const MAX_MEDIA_TYPE_LENGTH = 256
const mediaTypeToken = String.raw`[a-z0-9][a-z0-9.+_-]*`
const acceptedMediaTypePattern = new RegExp(
  String.raw`^${mediaTypeToken}\/(?:\*|${mediaTypeToken})$`,
)

export function isAcceptedMediaTypePattern(value) {
  return typeof value === "string"
    && value.length <= MAX_MEDIA_TYPE_LENGTH
    && acceptedMediaTypePattern.test(value)
}

// An attachment carries one exact media type. Wildcards belong to the manifest,
// never to the file the user sent.
export function normalizeAttachmentMediaType(value) {
  if (typeof value !== "string" || value.length > MAX_MEDIA_TYPE_LENGTH) return ""
  const mediaType = value.split(";", 1)[0].trim().toLowerCase()
  if (!acceptedMediaTypePattern.test(mediaType)) return ""
  if (mediaType.endsWith(MEDIA_TYPE_WILDCARD_SUFFIX)) return ""
  return mediaType
}

export function routeAcceptsMediaType(route, mediaType) {
  if (!route || typeof mediaType !== "string" || !mediaType) return false
  return route.acceptedMediaTypes.some((accepted) => (
    accepted === mediaType
    || (
      accepted.endsWith(MEDIA_TYPE_WILDCARD_SUFFIX)
      && mediaType.startsWith(accepted.slice(0, -1))
    )
  ))
}

const legacyRoutes = [
  {
    id: "minimax",
    display_name: "MiniMax M3",
    order: 0,
    target: {
      agent: "minimax",
      providerID: "minimax-coding-plan",
      modelID: "MiniMax-M3",
    },
    capabilities: {
      canExecuteCommands: false,
      canHandleNonLiteralText: false,
      canMutateProject: false,
      canReadRepository: true,
      canUseAgentMentions: false,
      canUseAttachments: true,
      canUseExternalTools: false,
    },
    acceptedMediaTypes: [
      "image/*",
      "text/plain",
      "video/*",
    ],
  },
  {
    id: "glm",
    display_name: "GLM 5.2",
    order: 1,
    target: {
      agent: "glm",
      providerID: "zai-coding-plan",
      modelID: "glm-5.2",
    },
    capabilities: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: false,
      canUseExternalTools: true,
    },
    acceptedMediaTypes: [],
  },
  {
    id: "claude",
    display_name: "Claude Opus 5 (xhigh)",
    order: 2,
    target: {
      agent: "claude",
      providerID: "claude-agent",
      modelID: "claude-opus-5",
    },
    capabilities: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true,
    },
    acceptedMediaTypes: [
      "application/pdf",
      "image/gif",
      "image/jpeg",
      "image/png",
      "image/webp",
      "text/plain",
    ],
  },
  {
    id: "codex",
    display_name: "GPT-5.6 Sol (xhigh)",
    order: 3,
    target: {
      agent: "codex",
      providerID: "openai",
      modelID: "gpt-5.6-sol",
    },
    capabilities: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true,
    },
    acceptedMediaTypes: [
      "application/pdf",
      "image/*",
      "text/plain",
    ],
  },
]

function exactObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value
}

function exactNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value
}

function exactKeys(value, expected, label) {
  const unknown = Object.keys(value).filter((key) => !expected.includes(key))
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} must contain exactly ${expected.join(", ")}`
      + `${missing.length > 0 ? `; missing: ${missing.join(", ")}` : ""}`
      + `${unknown.length > 0 ? `; unknown: ${unknown.join(", ")}` : ""}`,
    )
  }
}

function freezeRoute(route) {
  return Object.freeze({
    ...route,
    target: Object.freeze({ ...route.target }),
    capabilities: Object.freeze({ ...route.capabilities }),
    acceptedMediaTypes: Object.freeze([...route.acceptedMediaTypes]),
  })
}

function normalizeAcceptedMediaTypes(value, id, canUseAttachments) {
  if (value !== undefined && !Array.isArray(value)) {
    throw new TypeError(
      `route manifest route ${id} acceptedMediaTypes must be an array of media types`,
    )
  }
  const accepted = []
  for (const entry of value ?? []) {
    if (!isAcceptedMediaTypePattern(entry)) {
      throw new Error(
        `route manifest route ${id} declares an invalid accepted media type: ${String(entry)}`,
      )
    }
    if (accepted.includes(entry)) {
      throw new Error(
        `route manifest route ${id} declares a duplicate accepted media type: ${entry}`,
      )
    }
    accepted.push(entry)
  }
  for (const entry of accepted) {
    if (entry.endsWith(MEDIA_TYPE_WILDCARD_SUFFIX)) continue
    const wildcard = accepted.find((candidate) => (
      candidate.endsWith(MEDIA_TYPE_WILDCARD_SUFFIX)
      && entry.startsWith(candidate.slice(0, -1))
    ))
    if (wildcard) {
      throw new Error(
        `route manifest route ${id} accepted media type ${entry} is already covered by ${wildcard}`,
      )
    }
  }
  // The attachment capability and the accepted list describe the same fact, so a
  // manifest that states both differently is rejected instead of guessed.
  if (canUseAttachments && accepted.length === 0) {
    throw new Error(
      `route manifest route ${id} enables canUseAttachments without any accepted media type`,
    )
  }
  if (!canUseAttachments && accepted.length > 0) {
    throw new Error(
      `route manifest route ${id} declares accepted media types while canUseAttachments is false`,
    )
  }
  return accepted
}

function freezeManifest(routes, routing) {
  return Object.freeze({
    schema_version: ROUTE_MANIFEST_SCHEMA_VERSION,
    routes: Object.freeze(routes.map(freezeRoute)),
    routing: Object.freeze(routing.map((entry) => Object.freeze({ ...entry }))),
  })
}

function normalizeRouting(value, routeIDs) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("route manifest routing must be a non-empty array")
  }
  const intents = new Set()
  return value.map((entry, index) => {
    const routing = exactObject(entry, `route manifest routing[${index}]`)
    const intent = exactNonEmptyString(
      routing.intent,
      `route manifest routing[${index}].intent`,
    )
    const route = exactNonEmptyString(
      routing.route,
      `route manifest routing[${index}].route`,
    )
    if (intents.has(intent)) {
      throw new Error(`route manifest contains duplicate intent: ${intent}`)
    }
    if (!routeIDs.has(route)) {
      throw new Error(`route manifest intent ${intent} references unknown route: ${route}`)
    }
    intents.add(intent)
    return {
      intent,
      route,
      ...(typeof routing.help === "string" ? { help: routing.help } : {}),
      ...(typeof routing.description === "string"
        ? { description: routing.description }
        : {}),
    }
  })
}

function normalizeV2Manifest(value) {
  if (!Array.isArray(value.routes) || value.routes.length === 0) {
    throw new TypeError("route manifest routes must be a non-empty array")
  }
  const routeIDs = new Set()
  const targetAgents = new Set()
  const orders = new Set()
  const routes = value.routes.map((entry, index) => {
    const route = exactObject(entry, `route manifest routes[${index}]`)
    const id = exactNonEmptyString(route.id, `route manifest routes[${index}].id`)
    const displayName = exactNonEmptyString(
      route.display_name,
      `route manifest route ${id} display_name`,
    )
    if (routeIDs.has(id)) throw new Error(`route manifest contains duplicate route id: ${id}`)
    routeIDs.add(id)

    if (!Number.isInteger(route.order) || route.order < 0) {
      throw new TypeError(`route manifest route ${id} order must be a non-negative integer`)
    }
    if (orders.has(route.order)) {
      throw new Error(`route manifest contains duplicate route order: ${route.order}`)
    }
    orders.add(route.order)

    const target = exactObject(route.target, `route manifest route ${id} target`)
    exactKeys(target, ["agent", "providerID", "modelID"], `route manifest route ${id} target`)
    const agent = exactNonEmptyString(target.agent, `route manifest route ${id} target.agent`)
    if (RESERVED_ROUTER_AGENTS.includes(agent)) {
      throw new Error(`route manifest route ${id} target agent is reserved: ${agent}`)
    }
    if (targetAgents.has(agent)) {
      throw new Error(`route manifest contains duplicate target agent: ${agent}`)
    }
    targetAgents.add(agent)

    const capabilities = exactObject(
      route.capabilities,
      `route manifest route ${id} capabilities`,
    )
    exactKeys(capabilities, ROUTE_CAPABILITY_KEYS, `route manifest route ${id} capabilities`)
    for (const capability of ROUTE_CAPABILITY_KEYS) {
      if (typeof capabilities[capability] !== "boolean") {
        throw new TypeError(
          `route manifest route ${id} capability ${capability} must be boolean`,
        )
      }
    }

    return {
      id,
      display_name: displayName,
      order: route.order,
      target: {
        agent,
        providerID: exactNonEmptyString(
          target.providerID,
          `route manifest route ${id} target.providerID`,
        ),
        modelID: exactNonEmptyString(
          target.modelID,
          `route manifest route ${id} target.modelID`,
        ),
      },
      capabilities: Object.fromEntries(
        ROUTE_CAPABILITY_KEYS.map((capability) => [capability, capabilities[capability]]),
      ),
      acceptedMediaTypes: normalizeAcceptedMediaTypes(
        route.acceptedMediaTypes,
        id,
        capabilities.canUseAttachments,
      ),
    }
  }).sort((left, right) => left.order - right.order)

  return freezeManifest(routes, normalizeRouting(value.routing, routeIDs))
}

function legacyManifest(value) {
  const config = exactObject(value, "legacy route config")
  const configuredRoutes = Array.isArray(config.routes) ? config.routes : []
  const displayNames = new Map(configuredRoutes.map((entry, index) => {
    const route = exactObject(entry, `legacy route config routes[${index}]`)
    const id = exactNonEmptyString(
      route.id ?? route.name,
      `legacy route config routes[${index}].name`,
    )
    return [id, route.display_name]
  }))
  const routes = legacyRoutes.map((route) => ({
    ...route,
    display_name: typeof displayNames.get(route.id) === "string"
      && displayNames.get(route.id).trim()
      ? displayNames.get(route.id)
      : route.display_name,
  }))
  const routeIDs = new Set(routes.map(({ id }) => id))
  return freezeManifest(routes, normalizeRouting(config.routing, routeIDs))
}

export function normalizeRouteManifest(value) {
  const manifest = exactObject(value, "route manifest")
  if (manifest.schema_version === undefined || manifest.schema_version === 1) {
    return legacyManifest(manifest)
  }
  if (manifest.schema_version !== ROUTE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `unsupported route manifest schema_version: ${String(manifest.schema_version)}`,
    )
  }
  return normalizeV2Manifest(manifest)
}

export function parseRouteManifest(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new TypeError("route manifest output must be non-empty JSON text")
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_ROUTE_MANIFEST_BYTES) {
    throw new Error(`route manifest output exceeds ${MAX_ROUTE_MANIFEST_BYTES} UTF-8 bytes`)
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`route manifest output is invalid JSON: ${error.message}`)
  }
  return normalizeRouteManifest(value)
}

export function applyRouteManifestOverride(manifest, override) {
  const value = exactObject(override, "route manifest project override")
  exactKeys(
    value,
    ["schema_version", "routes"],
    "route manifest project override",
  )
  if (value.schema_version !== ROUTE_MANIFEST_OVERRIDE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported route manifest project override schema_version: ${String(value.schema_version)}`,
    )
  }
  const routeOverrides = exactObject(
    value.routes,
    "route manifest project override routes",
  )
  const routes = manifest.routes.map((route) => {
    const entry = routeOverrides[route.id]
    if (entry === undefined) return route
    const routeOverride = exactObject(
      entry,
      `route manifest project override route ${route.id}`,
    )
    exactKeys(
      routeOverride,
      ["capabilities"],
      `route manifest project override route ${route.id}`,
    )
    const capabilities = exactObject(
      routeOverride.capabilities,
      `route manifest project override route ${route.id} capabilities`,
    )
    if (Object.keys(capabilities).length === 0) {
      throw new Error(
        `route manifest project override route ${route.id} capabilities must not be empty`,
      )
    }
    for (const [capability, enabled] of Object.entries(capabilities)) {
      if (!ROUTE_CAPABILITY_KEYS.includes(capability)) {
        throw new Error(
          `route manifest project override route ${route.id}`
          + ` contains unknown capability: ${capability}`,
        )
      }
      if (enabled !== false) {
        throw new Error(
          `route manifest project override route ${route.id}`
          + ` may only set capabilities to false: ${capability}`,
        )
      }
    }
    const nextCapabilities = {
      ...route.capabilities,
      ...capabilities,
    }
    return {
      ...route,
      capabilities: nextCapabilities,
      // Disabling attachments for a project also drops the media types that
      // capability authorized.
      acceptedMediaTypes: nextCapabilities.canUseAttachments
        ? route.acceptedMediaTypes
        : [],
    }
  })
  const knownRouteIDs = new Set(manifest.routes.map(({ id }) => id))
  const unknownRouteIDs = Object.keys(routeOverrides).filter((id) => !knownRouteIDs.has(id))
  if (unknownRouteIDs.length > 0) {
    throw new Error(
      `route manifest project override contains unknown routes: ${unknownRouteIDs.join(", ")}`,
    )
  }
  return normalizeRouteManifest({
    schema_version: ROUTE_MANIFEST_SCHEMA_VERSION,
    routes,
    routing: manifest.routing,
  })
}

export function parseRouteManifestOverride(raw, manifest, source = "project override") {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new TypeError(`${source} must contain non-empty JSON text`)
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_ROUTE_MANIFEST_OVERRIDE_BYTES) {
    throw new Error(
      `${source} exceeds ${MAX_ROUTE_MANIFEST_OVERRIDE_BYTES} UTF-8 bytes`,
    )
  }
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${source} is invalid JSON: ${error.message}`)
  }
  return applyRouteManifestOverride(manifest, value)
}

export const LEGACY_ROUTE_MANIFEST = legacyManifest({
  routes: legacyRoutes,
  routing: legacyRoutes.map(({ id }) => ({ intent: `legacy_${id}`, route: id })),
})

export function routeManifestEntry(manifest, routeID) {
  return manifest.routes.find(({ id }) => id === routeID)
}

export function routeManifestEntryForAgent(manifest, agent) {
  return manifest.routes.find((route) => route.target.agent === agent)
}
