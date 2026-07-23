const emptyUsage = Object.freeze({
  inputTokens: Object.freeze({ total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }),
  outputTokens: Object.freeze({ total: 0, text: 0, reasoning: 0 }),
  raw: Object.freeze({}),
})

function controlText(prompt) {
  if (!Array.isArray(prompt)) throw new Error("router-control prompt must be an array")
  const current = prompt.findLast((message) => message?.role === "user")
  if (!current || !Array.isArray(current.content)) {
    throw new Error("router-control prompt has no current user message")
  }
  const text = current.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
  if (!text.trim()) throw new Error("router-control prompt has no text response")
  return text
}

function finishReason() {
  return { unified: "stop", raw: "stop" }
}

function languageModel(modelID, providerName) {
  return {
    specificationVersion: "v3",
    provider: providerName,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(callOptions) {
      const text = controlText(callOptions.prompt)
      return {
        content: [{ type: "text", text }],
        finishReason: finishReason(),
        usage: structuredClone(emptyUsage),
        warnings: [],
        response: { id: "router-control", modelId: modelID },
      }
    },
    async doStream(callOptions) {
      const text = controlText(callOptions.prompt)
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] })
            controller.enqueue({ type: "text-start", id: "router-control-text" })
            controller.enqueue({
              type: "text-delta",
              id: "router-control-text",
              delta: text,
            })
            controller.enqueue({ type: "text-end", id: "router-control-text" })
            controller.enqueue({
              type: "response-metadata",
              id: "router-control",
              modelId: modelID,
            })
            controller.enqueue({
              type: "finish",
              usage: structuredClone(emptyUsage),
              finishReason: finishReason(),
            })
            controller.close()
          },
        }),
      }
    },
  }
}

export function createRouterControl(options = {}) {
  const providerName = options.name ?? "router-control"
  return {
    languageModel(modelID = "control") {
      return languageModel(modelID, providerName)
    },
  }
}
