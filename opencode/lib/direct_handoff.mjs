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
  enforceMinimumRoute,
  routeTarget,
} from "./routing_policy.mjs"
import { updateSessionMetadata } from "./session_metadata.mjs"

export const MANUAL_TARGET_METADATA_KEY = "llm-router.manual.target"

function exactUserRequest(parts) {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("")
}

function classifyRequest(classify, request, requirements) {
  return Promise.resolve(classify(request)).then((result) => {
    const raw = typeof result === "string" ? result : result?.stdout
    if (typeof raw !== "string") {
      throw new Error("llm-router returned no classifier output")
    }

    const classified = parseClassifierResult(raw.trim())
    const route = enforceMinimumRoute(classified.route, request, {
      ...requirements,
      intent: classified.intent,
    })
    return { classified, route, target: routeTarget(route) }
  })
}

function selectRequest(classify, request, requirements) {
  if (
    request.length === 0
    && (requirements.hasAgentMentions || requirements.hasAttachments)
  ) {
    const route = "claude"
    return Promise.resolve({
      classified: undefined,
      route,
      target: routeTarget(route),
    })
  }
  return classifyRequest(classify, request, requirements)
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

function storedManualTarget(metadata, sessionID) {
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

  const target = routeTarget(stored.target.agent)
  if (
    stored.target.providerID !== target.providerID
    || stored.target.modelID !== target.modelID
  ) {
    throw new Error("OpenCode session has an invalid manual routing target")
  }
  return target
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
  adaptivePolicy,
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
      const stored = readRoutingState(currentMetadata, sessionID)
      const legacy = mode === "pinned"
        ? storedManualTarget(currentMetadata, sessionID)
        : undefined
      const state = transitionRoutingState({
        state: stored,
        sessionID,
        mode,
        recommendedRoute: mode === "pinned" && stored?.mode === "pinned"
          ? stored.currentRoute
          : legacy?.agent ?? recommendedRoute,
        request,
        policy: adaptivePolicy,
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
  sessionID,
  adaptivePolicy,
}) {
  requireRoutingSessionClient(client)
  const storedState = readRoutingState(metadata, sessionID)
  const legacyTarget = mode === "pinned"
    ? storedManualTarget(metadata, sessionID)
    : undefined
  const pinnedRoute = storedState?.mode === "pinned"
    ? storedState.currentRoute
    : legacyTarget?.agent
  let recommended
  let reused = false
  if (mode === "pinned" && pinnedRoute) {
    const target = routeTarget(pinnedRoute)
    recommended = {
      classified: undefined,
      route: pinnedRoute,
      target,
    }
    reused = true
  } else {
    recommended = await selectRequest(classify, request, requirements)
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
    adaptivePolicy,
  })
  const route = nextState.currentRoute
  return {
    classified: recommended.classified,
    recommendedRoute: recommended.route,
    reused: reused || route !== recommended.route,
    route,
    target: routeTarget(route),
  }
}

export function createDirectModelHandoff({
  classify,
  client,
  announce = async () => {},
  adaptivePolicy,
}) {
  if (typeof classify !== "function") throw new TypeError("classify must be a function")
  if (typeof announce !== "function") throw new TypeError("announce must be a function")
  const adaptiveThresholds = normalizeAdaptiveRoutingPolicy(adaptivePolicy)

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? output.message?.agent
      if (!isManagedRouterAgent(agent)) return

      const request = exactUserRequest(output.parts)
      const requirements = {
        hasAgentMentions: output.parts.some((part) => part.type === "agent"),
        hasAttachments: output.parts.some((part) => part.type === "file"),
      }
      if (
        request.length === 0
        && !requirements.hasAgentMentions
        && !requirements.hasAttachments
      ) return

      const state = await sessionState(client, input.sessionID)
      const storedState = readRoutingState(state.metadata, input.sessionID)
      const legacyTarget = storedManualTarget(state.metadata, input.sessionID)
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
        sessionID: input.sessionID,
        adaptivePolicy: adaptiveThresholds,
      })

      output.message.agent = selection.target.agent
      output.message.model = {
        providerID: selection.target.providerID,
        modelID: selection.target.modelID,
      }

      try {
        await announce({ mode, ...selection })
      } catch {
        // A UI notification must never block the selected model from running.
      }
    },
  }
}
