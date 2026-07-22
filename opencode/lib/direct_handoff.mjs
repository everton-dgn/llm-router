import { parseClassifierResult } from "./route_contract.mjs"
import { enforceMinimumRoute, routeTarget } from "./routing_policy.mjs"

const managedAgents = new Set(["router-auto", "router-manual"])

export const MANUAL_TARGET_METADATA_KEY = "llm-router.manual.target"

function exactUserRequest(parts) {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("")
}

function classifyRequest(classify, request) {
  return Promise.resolve(classify(request)).then((result) => {
    const raw = typeof result === "string" ? result : result?.stdout
    if (typeof raw !== "string") {
      throw new Error("llm-router returned no classifier output")
    }

    const classified = parseClassifierResult(raw.trim())
    const route = enforceMinimumRoute(classified.route, request)
    return { classified, route, target: routeTarget(route) }
  })
}

function requireSessionReader(client) {
  if (typeof client?.session?.get !== "function") {
    throw new Error("OpenCode v2 session get client is required for routing")
  }
  return client.session
}

function requireManualSessionClient(client) {
  const session = requireSessionReader(client)
  if (
    typeof session.update !== "function"
    || typeof client?.v2?.session?.switchAgent !== "function"
  ) {
    throw new Error("OpenCode v2 session metadata and agent clients are required for manual routing")
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
  requireManualSessionClient(client)
  await client.v2.session.switchAgent(
    { sessionID, agent: "router-manual" },
    { throwOnError: true },
  )
}

async function manualSelection({ classify, client, current, metadata, request, sessionID }) {
  const sessionClient = requireManualSessionClient(client)
  const stored = storedManualTarget(metadata, sessionID)
  if (stored) {
    await keepManualRouterSelected(client, sessionID, current)
    return {
      classified: undefined,
      reused: true,
      route: stored.agent,
      target: stored,
    }
  }

  const selected = await classifyRequest(classify, request)
  await sessionClient.update({
    sessionID,
    metadata: {
      ...metadata,
      [MANUAL_TARGET_METADATA_KEY]: {
        sessionID,
        target: selected.target,
      },
    },
  }, { throwOnError: true })
  await keepManualRouterSelected(client, sessionID, current)
  return { ...selected, reused: false }
}

export function createDirectModelHandoff({
  classify,
  client,
  announce = async () => {},
}) {
  if (typeof classify !== "function") throw new TypeError("classify must be a function")
  if (typeof announce !== "function") throw new TypeError("announce must be a function")

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? output.message?.agent
      if (!managedAgents.has(agent)) return

      const request = exactUserRequest(output.parts)
      if (request.length === 0) return

      const state = await sessionState(client, input.sessionID)
      const stickyTarget = storedManualTarget(state.metadata, input.sessionID)
      const mode = agent === "router-manual" || stickyTarget ? "manual" : "auto"
      const selection = mode === "manual"
        ? await manualSelection({
            classify,
            client,
            current: state.current,
            metadata: state.metadata,
            request,
            sessionID: input.sessionID,
          })
        : { ...await classifyRequest(classify, request), reused: false }

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
