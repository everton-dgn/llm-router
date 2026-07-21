const STORE_SYMBOL = Symbol.for("llm-router.prompt-guard.store.v1")

function requestStore() {
  const existing = globalThis[STORE_SYMBOL]
  if (existing instanceof Map) return existing

  const store = new Map()
  Object.defineProperty(globalThis, STORE_SYMBOL, {
    value: store,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return store
}

export function requireRouterRequest(sessionID) {
  const request = requestStore().get(sessionID)
  if (request === undefined) {
    throw new Error("original router request is unavailable for this session")
  }
  return request
}

export function createRouterPromptGuard() {
  const originalRequests = requestStore()

  return {
    "chat.message": async (input, output) => {
      const agent = input.agent ?? output.message?.agent
      if (agent !== "router") return

      const request = output.parts
        .filter((part) => part.type === "text" && part.synthetic !== true)
        .map((part) => part.text)
        .join("")
      if (request.length === 0) return

      originalRequests.set(input.sessionID, request)
    },
    event: async ({ event }) => {
      if (event.type !== "session.idle" && event.type !== "session.deleted") return
      originalRequests.delete(event.properties.sessionID)
    },
    dispose: async () => {
      originalRequests.clear()
    },
  }
}
