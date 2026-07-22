import { parseClassifierResult } from "./route_contract.mjs"
import { enforceMinimumRoute, routeTarget } from "./routing_policy.mjs"

const managedAgents = new Set(["router", "minimax", "glm", "claude", "codex"])

function exactUserRequest(parts) {
  return parts
    .filter((part) => part.type === "text" && part.synthetic !== true)
    .map((part) => part.text)
    .join("")
}

export async function persistDirectModelSelection(client, sessionID, target, previous) {
  if (typeof sessionID !== "string" || !sessionID) {
    throw new Error("OpenCode session ID is required to persist the handoff")
  }
  if (typeof previous?.agent !== "string" || !previous.agent) {
    throw new Error("Previous OpenCode agent is required to compensate a failed handoff")
  }
  await client.v2.session.switchAgent(
    { sessionID, agent: target.agent },
    { throwOnError: true },
  )
  try {
    await client.v2.session.switchModel(
      {
        sessionID,
        model: { providerID: target.providerID, id: target.modelID },
      },
      { throwOnError: true },
    )
  } catch (modelError) {
    try {
      await client.v2.session.switchAgent(
        { sessionID, agent: previous.agent },
        { throwOnError: true },
      )
    } catch (rollbackError) {
      throw new AggregateError(
        [modelError, rollbackError],
        "OpenCode model switch failed and the previous agent could not be restored",
      )
    }
    throw modelError
  }
}

export function createDirectModelHandoff({
  classify,
  persist = async () => {},
  announce = async () => {},
}) {
  if (typeof classify !== "function") throw new TypeError("classify must be a function")
  if (typeof persist !== "function") throw new TypeError("persist must be a function")

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? output.message?.agent
      if (!managedAgents.has(agent)) return

      const request = exactUserRequest(output.parts)
      if (request.length === 0) return

      const result = await classify(request)
      const raw = typeof result === "string" ? result : result?.stdout
      if (typeof raw !== "string") {
        throw new Error("llm-router returned no classifier output")
      }

      const classified = parseClassifierResult(raw.trim())
      const route = enforceMinimumRoute(classified.route, request)
      const target = routeTarget(route)
      const previous = {
        agent: output.message?.agent ?? input.agent,
        providerID: output.message?.model?.providerID ?? input.model?.providerID,
        modelID: output.message?.model?.modelID ?? input.model?.modelID,
      }

      await persist({ input, target, previous, classified })

      output.message.agent = target.agent
      output.message.model = {
        providerID: target.providerID,
        modelID: target.modelID,
      }

      try {
        await announce({ route, target, classified })
      } catch {
        // A UI notification must never block the selected model from running.
      }
    },
  }
}
