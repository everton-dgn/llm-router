// The toast is the only routing feedback the TUI can show from a plugin, so it
// fires when the state changes instead of once per message. OpenCode 1.18.4
// builds a user prompt from text and file parts and draws neither a synthetic
// nor an ignored one, and a part added to the assistant message would enter the
// prompt of every later call, so a persistent line in the conversation is not
// available here.

const MAX_TRACKED_ROUTER_STATES = 256

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`llm-router feedback requires a non-empty ${field}`)
  }
  return value.trim()
}

export function routerStateSignature(state) {
  const mode = requireText(state?.mode, "mode")
  const profile = requireText(state?.profile, "profile")
  const providerID = requireText(state?.providerID, "providerID")
  const modelID = requireText(state?.modelID, "modelID")
  return `${mode}|${profile}|${providerID}/${modelID}`
}

export function createRouterAnnouncer({ maxSessions = MAX_TRACKED_ROUTER_STATES } = {}) {
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new Error("llm-router feedback maxSessions must be a positive integer")
  }
  const states = new Map()
  return {
    changed(sessionID, state) {
      const key = requireText(sessionID, "sessionID")
      const signature = routerStateSignature(state)
      if (states.get(key) === signature) return false
      if (states.size >= maxSessions && !states.has(key)) states.clear()
      states.set(key, signature)
      return true
    },
    forget(sessionID) {
      states.delete(sessionID)
    },
    get size() {
      return states.size
    },
  }
}
