import { parseClassifierResult } from "./route_contract.mjs"
import {
  isManagedRouterAgent,
  normalizeAdaptiveRoutingPolicy,
  readRoutingState,
  resolveRoutingMode,
  ROUTING_STATE_METADATA_KEY,
  transitionRoutingState,
} from "./adaptive_routing.mjs"
import {
  attachmentMediaTypes,
  enforceMediaCompatibleRoute,
  enforceMinimumRoute,
  minimumCompatibleRoute,
  routeSupportsRequest,
  routeTarget,
  unsupportedRouteMediaTypes,
} from "./routing_policy.mjs"
import {
  LEGACY_ROUTE_MANIFEST,
  normalizeAttachmentMediaType,
  routeManifestEntry,
  routeManifestEntryForAgent,
} from "./route_manifest.mjs"
import { updateSessionMetadata } from "./session_metadata.mjs"

export const MANUAL_TARGET_METADATA_KEY = "llm-router.manual.target"

const MAX_TRACKED_MEDIA_NOTICES = 256

function exactUserRequest(parts) {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("")
}

function dataURLMediaType(url) {
  if (typeof url !== "string" || !url.startsWith("data:")) return ""
  return url.slice("data:".length).split(",", 1)[0].split(";", 1)[0]
}

function partMediaType(part) {
  const declared = normalizeAttachmentMediaType(part.mime)
  if (declared) return declared
  return dataURLMediaType(part.url)
}

function exactAttachmentMediaTypes(parts) {
  return attachmentMediaTypes(
    parts.filter((part) => part.type === "file").map(partMediaType),
  )
}

function mediaFallbackBetween(intendedRoute, route, mediaTypes, manifest) {
  if (!intendedRoute || intendedRoute === route || mediaTypes.length === 0) return
  if (!routeManifestEntry(manifest, intendedRoute)) return
  const unsupported = unsupportedRouteMediaTypes(intendedRoute, mediaTypes, manifest)
  if (unsupported.length === 0) return
  return { from: intendedRoute, to: route, unsupported }
}

// The same forced fallback repeated on consecutive messages is one event for
// the user, so only its first message carries a notice.
function pendingMediaNotice(notices, sessionID, fallback) {
  if (!fallback) {
    notices.delete(sessionID)
    return
  }
  const notice = `${fallback.from}->${fallback.to}:${fallback.unsupported.join(",")}`
  if (notices.get(sessionID) === notice) return
  if (notices.size >= MAX_TRACKED_MEDIA_NOTICES) notices.clear()
  notices.set(sessionID, notice)
  return fallback
}

function classifyRequest(classify, request, requirements, manifest) {
  return Promise.resolve(classify(request)).then((result) => {
    const raw = typeof result === "string" ? result : result?.stdout
    if (typeof raw !== "string") {
      throw new Error("llm-router returned no classifier output")
    }

    const classified = parseClassifierResult(raw.trim(), manifest)
    const route = enforceMinimumRoute(
      classified.route,
      request,
      requirements,
      manifest,
    )
    return {
      classified,
      intendedRoute: classified.route,
      route,
      target: routeTarget(route, manifest),
    }
  })
}

function selectRequest(classify, request, requirements, manifest, sessionRoute) {
  if (
    request.length === 0
    && (requirements.hasAgentMentions || requirements.hasAttachments)
  ) {
    // A message carrying only files keeps the session on its current route
    // whenever that route can read every attachment.
    const reusable = sessionRoute !== undefined
      && routeManifestEntry(manifest, sessionRoute) !== undefined
      && routeSupportsRequest(sessionRoute, request, requirements, manifest)
    const route = reusable
      ? sessionRoute
      : minimumCompatibleRoute(request, requirements, manifest)
    return Promise.resolve({
      classified: undefined,
      intendedRoute: sessionRoute ?? route,
      route,
      target: routeTarget(route, manifest),
    })
  }
  return classifyRequest(classify, request, requirements, manifest)
}

function requireSessionReader(client) {
  if (typeof client?.session?.get !== "function") {
    throw new Error("OpenCode v2 session get client is required for routing")
  }
  return client.session
}

function requireRoutingSessionClient(client) {
  const session = requireSessionReader(client)
  if (typeof session.update !== "function") {
    throw new Error("OpenCode v2 session metadata client is required for routing")
  }
  return session
}

function responseData(response) {
  if (
    response
    && typeof response === "object"
    && Object.prototype.hasOwnProperty.call(response, "data")
  ) return response.data
  return response
}

function sessionMetadata(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new Error("OpenCode returned no session data for manual routing")
  }
  if (session.metadata === undefined) return {}
  if (
    !session.metadata
    || typeof session.metadata !== "object"
    || Array.isArray(session.metadata)
  ) {
    throw new Error("OpenCode session metadata is invalid for manual routing")
  }
  return session.metadata
}

function storedManualTarget(metadata, sessionID, manifest) {
  const stored = metadata[MANUAL_TARGET_METADATA_KEY]
  if (stored === undefined) return
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("OpenCode session has an invalid manual routing target")
  }

  // Forks clone session metadata. A target belongs only to the session that
  // selected it, so inherited records must be classified again.
  if (stored.sessionID !== sessionID) return
  if (!stored.target || typeof stored.target !== "object" || Array.isArray(stored.target)) {
    throw new Error("OpenCode session has an invalid manual routing target")
  }
  if (
    typeof stored.target.agent !== "string"
    || !stored.target.agent
    || typeof stored.target.providerID !== "string"
    || !stored.target.providerID
    || typeof stored.target.modelID !== "string"
    || !stored.target.modelID
  ) {
    throw new Error("OpenCode session has an invalid manual routing target")
  }

  const route = routeManifestEntryForAgent(manifest, stored.target.agent)
  if (!route) return { route: undefined, target: undefined }
  const target = route.target
  if (
    stored.target.providerID !== target.providerID
    || stored.target.modelID !== target.modelID
  ) {
    return { route: undefined, target: undefined }
  }
  return { route: route.id, target }
}

async function sessionState(client, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) {
    throw new Error("OpenCode session ID is required for routing")
  }
  const sessionClient = requireSessionReader(client)
  const current = responseData(await sessionClient.get({
    sessionID,
  }, { throwOnError: true }))
  return { current, metadata: sessionMetadata(current) }
}

async function keepManualRouterSelected(client, sessionID, current) {
  if (current.agent === "router-manual") return
  if (typeof client?.v2?.session?.switchAgent !== "function") {
    throw new Error("OpenCode v2 session agent client is required for legacy manual routing")
  }
  await client.v2.session.switchAgent(
    { sessionID, agent: "router-manual" },
    { throwOnError: true },
  )
}

async function persistRoutingState({
  client,
  sessionID,
  mode,
  recommendedRoute,
  request,
  requirements,
  adaptivePolicy,
  manifest,
}) {
  const sessionClient = requireRoutingSessionClient(client)
  const nextMetadata = await updateSessionMetadata({
    sessionID,
    readMetadata: async (currentSessionID) => {
      const current = responseData(await sessionClient.get(
        { sessionID: currentSessionID },
        { throwOnError: true },
      ))
      return sessionMetadata(current)
    },
    writeMetadata: async (currentSessionID, metadata) => {
      await sessionClient.update(
        { sessionID: currentSessionID, metadata },
        { throwOnError: true },
      )
    },
    update: (currentMetadata) => {
      const stored = readRoutingState(currentMetadata, sessionID, manifest)
      const legacy = mode === "pinned"
        ? storedManualTarget(currentMetadata, sessionID, manifest)
        : undefined
      const state = transitionRoutingState({
        state: stored,
        sessionID,
        mode,
        recommendedRoute: mode === "pinned"
          && stored?.mode === "pinned"
          && stored.currentRoute
          ? stored.currentRoute
          : legacy?.route ?? recommendedRoute,
        request,
        requirements,
        policy: adaptivePolicy,
        manifest,
      })
      return {
        ...currentMetadata,
        [ROUTING_STATE_METADATA_KEY]: state,
      }
    },
  })
  return nextMetadata[ROUTING_STATE_METADATA_KEY]
}

async function selectForMode({
  classify,
  client,
  current,
  metadata,
  mode,
  agent,
  request,
  requirements,
  mediaTypes,
  sessionID,
  adaptivePolicy,
  manifest,
}) {
  requireRoutingSessionClient(client)
  const storedState = readRoutingState(metadata, sessionID, manifest)
  const legacyTarget = mode === "pinned"
    ? storedManualTarget(metadata, sessionID, manifest)
    : undefined
  const pinnedRoute = storedState?.mode === "pinned"
    ? storedState.currentRoute
    : legacyTarget?.route
  let recommended
  let reused = false
  if (mode === "pinned" && pinnedRoute) {
    const target = routeTarget(pinnedRoute, manifest)
    recommended = {
      classified: undefined,
      intendedRoute: pinnedRoute,
      route: pinnedRoute,
      target,
    }
    reused = true
  } else {
    recommended = await selectRequest(
      classify,
      request,
      requirements,
      manifest,
      storedState?.currentRoute,
    )
  }

  if (mode === "pinned" && agent === "router-manual") {
    await keepManualRouterSelected(client, sessionID, current)
  }

  const nextState = await persistRoutingState({
    client,
    sessionID,
    mode,
    recommendedRoute: recommended.route,
    request,
    requirements,
    adaptivePolicy,
    manifest,
  })
  // A pinned session keeps its stored route: an incompatible attachment only
  // borrows a compatible route for this single message.
  const route = enforceMediaCompatibleRoute(
    nextState.currentRoute,
    mediaTypes,
    manifest,
  )
  return {
    classified: recommended.classified,
    recommendedRoute: recommended.route,
    reused: reused || route !== recommended.route,
    route,
    target: routeTarget(route, manifest),
    mediaFallback: mediaFallbackBetween(
      recommended.intendedRoute,
      route,
      mediaTypes,
      manifest,
    ),
  }
}

export function createDirectModelHandoff({
  classify,
  client,
  announce = async () => {},
  adaptivePolicy,
  manifest = LEGACY_ROUTE_MANIFEST,
}) {
  if (typeof classify !== "function") throw new TypeError("classify must be a function")
  if (typeof announce !== "function") throw new TypeError("announce must be a function")
  const adaptiveThresholds = normalizeAdaptiveRoutingPolicy(adaptivePolicy)
  const mediaNotices = new Map()

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? output.message?.agent
      if (!isManagedRouterAgent(agent)) return

      const request = exactUserRequest(output.parts)
      const mediaTypes = exactAttachmentMediaTypes(output.parts)
      const requirements = {
        hasAgentMentions: output.parts.some((part) => part.type === "agent"),
        hasAttachments: output.parts.some((part) => part.type === "file"),
        attachmentMediaTypes: mediaTypes,
      }
      if (
        request.length === 0
        && !requirements.hasAgentMentions
        && !requirements.hasAttachments
      ) return

      const state = await sessionState(client, input.sessionID)
      const storedState = readRoutingState(state.metadata, input.sessionID, manifest)
      const legacyTarget = storedManualTarget(state.metadata, input.sessionID, manifest)
      const mode = resolveRoutingMode({
        agent,
        state: storedState,
        hasLegacyPinnedTarget: legacyTarget !== undefined,
      })
      const selection = await selectForMode({
        classify,
        client,
        current: state.current,
        metadata: state.metadata,
        mode,
        agent,
        request,
        requirements,
        mediaTypes,
        sessionID: input.sessionID,
        adaptivePolicy: adaptiveThresholds,
        manifest,
      })

      output.message.agent = selection.target.agent
      output.message.model = {
        providerID: selection.target.providerID,
        modelID: selection.target.modelID,
      }

      try {
        await announce({
          mode,
          ...selection,
          sessionID: input.sessionID,
          mediaFallback: pendingMediaNotice(
            mediaNotices,
            input.sessionID,
            selection.mediaFallback,
          ),
        })
      } catch {
        // A UI notification must never block the selected model from running.
      }
    },
  }
}
