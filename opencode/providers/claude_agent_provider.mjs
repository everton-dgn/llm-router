import {
  CLAUDE_MODEL,
  CLAUDE_TIMEOUT_MS,
  runClaudeCli,
} from "../lib/claude_agent.mjs"

export const CLAUDE_MAX_INPUT_BYTES = 128 * 1024
export const CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS = 32_000

const TRANSCRIPT_INSTRUCTION = "Continue the conversation in the JSON array below. Reply to the final user message."

function utf8Bytes(value) {
  return new TextEncoder().encode(value).byteLength
}

function validateCurrentUserPart(part) {
  if (!part || typeof part !== "object" || typeof part.type !== "string") {
    throw new Error("Claude adapter received an unknown user message part")
  }
  if (part.type === "file") {
    throw new Error("Claude adapter does not accept file attachments")
  }
  if (["tool-call", "tool-result", "tool-approval-response"].includes(part.type)) {
    throw new Error(`Claude adapter does not accept ${part.type} history`)
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      throw new Error("Claude adapter received invalid user text")
    }
    return
  }
  throw new Error(`Claude adapter does not support user message part: ${part.type}`)
}

function validateSafeConversation(conversation, currentRequest) {
  if (!Array.isArray(conversation) || conversation.length === 0) {
    throw new Error("Claude adapter received invalid safe conversation context")
  }
  for (const message of conversation) {
    if (
      !message
      || !["user", "assistant"].includes(message.role)
      || typeof message.content !== "string"
      || !message.content.trim()
    ) {
      throw new Error("Claude adapter received invalid safe conversation context")
    }
  }
  const last = conversation.at(-1)
  if (last.role !== "user" || last.content !== currentRequest) {
    throw new Error("Claude safe conversation does not match the current user message")
  }
  return conversation
}

export function serializeClaudePrompt(prompt, safeConversation) {
  if (!Array.isArray(prompt)) throw new Error("Claude adapter prompt must be an array")

  const currentUserIndex = prompt.findLastIndex((message) => message?.role === "user")
  if (currentUserIndex === -1) {
    throw new Error("Claude adapter prompt contains no current user message")
  }
  const currentUser = prompt[currentUserIndex]

  for (const [index, message] of prompt.entries()) {
    if (!message || typeof message !== "object") continue
    if (index !== currentUserIndex) continue
    if (!Array.isArray(message.content)) {
      throw new Error("Claude adapter received an invalid current user message")
    }
    for (const part of message.content) validateCurrentUserPart(part)
  }

  const currentRequest = currentUser.content.map((part) => part.text).join("")
  if (!currentRequest.trim()) throw new Error("Claude adapter prompt contains no current user text")

  const transcript = safeConversation === undefined
    ? [{ role: "user", content: currentRequest }]
    : validateSafeConversation(safeConversation, currentRequest)

  const request = transcript.length === 1
    ? currentRequest
    : `${TRANSCRIPT_INSTRUCTION}\n\n${JSON.stringify(transcript)}`
  const inputBytes = utf8Bytes(request)
  if (inputBytes > CLAUDE_MAX_INPUT_BYTES) {
    throw new Error(`Claude input exceeds the ${CLAUDE_MAX_INPUT_BYTES}-byte input limit`)
  }

  return {
    request,
  }
}

function sumModelUsage(modelUsage, key) {
  return Object.values(modelUsage ?? {}).reduce((total, usage) => {
    const value = usage?.[key]
    return total + (Number.isFinite(value) ? value : 0)
  }, 0)
}

export function mapClaudeUsage(result) {
  const input = sumModelUsage(result.modelUsage, "inputTokens")
  const cacheRead = sumModelUsage(result.modelUsage, "cacheReadInputTokens")
  const cacheWrite = sumModelUsage(result.modelUsage, "cacheCreationInputTokens")
  const output = sumModelUsage(result.modelUsage, "outputTokens")

  return {
    inputTokens: {
      total: input + cacheRead + cacheWrite,
      noCache: input,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: output,
      text: output,
      reasoning: undefined,
    },
    raw: {
      totalCostUsd: Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : 0,
      turns: Number.isFinite(result.num_turns) ? result.num_turns : 0,
    },
  }
}

function finishReason(result) {
  return {
    unified: result.stop_reason === "max_tokens" ? "length" : "stop",
    raw: result.stop_reason ?? undefined,
  }
}

function runtimeOptions(callOptions, providerName, defaults) {
  const provided = callOptions.providerOptions?.[providerName] ?? {}
  const cwd = provided.cwd
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Claude adapter requires a workspace cwd from chat.params")
  }
  const claudePath = provided.claudePath ?? defaults.claudePath
  if (typeof claudePath !== "string" || !claudePath.trim()) {
    throw new Error("Claude adapter requires an absolute Claude executable path")
  }
  const maxOutputTokens = callOptions.maxOutputTokens
    ?? defaults.maxOutputTokens
    ?? CLAUDE_DEFAULT_MAX_OUTPUT_TOKENS
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("Claude adapter requires maxOutputTokens to be a positive integer")
  }
  return {
    cwd,
    claudePath,
    safeConversation: provided.safeConversation,
    timeoutMs: provided.timeoutMs ?? defaults.timeoutMs ?? CLAUDE_TIMEOUT_MS,
    maxOutputTokens,
  }
}

function limitedMessageHandler(maxOutputTokens, onMessage) {
  let streamedBytes = 0
  const exceeded = () => new Error(
    `Claude output exceeded maxOutputTokens ${maxOutputTokens} using conservative UTF-8 byte accounting`,
  )

  return async (message) => {
    if (message?.type === "stream_event" && message.parent_tool_use_id === null) {
      const event = message.event
      if (event?.type === "content_block_start" && event.content_block?.type === "text") {
        streamedBytes += utf8Bytes(event.content_block.text ?? "")
      }
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
        streamedBytes += utf8Bytes(event.delta.text ?? "")
      }
      if (streamedBytes > maxOutputTokens) throw exceeded()
    }
    if (message?.type === "result" && message.subtype === "success") {
      if (utf8Bytes(message.result ?? "") > maxOutputTokens) throw exceeded()
    }
    await onMessage?.(message)
  }
}

function languageModel(modelID, providerName, defaults) {
  async function execute(callOptions, signal = callOptions.abortSignal, onMessage) {
    const runtime = runtimeOptions(callOptions, providerName, defaults)
    const prompt = serializeClaudePrompt(callOptions.prompt, runtime.safeConversation)
    return runClaudeCli({
      request: prompt.request,
      cwd: runtime.cwd,
      model: modelID,
      claudePath: runtime.claudePath,
      parentSignal: signal,
      timeoutMs: runtime.timeoutMs,
      onMessage: limitedMessageHandler(runtime.maxOutputTokens, onMessage),
      spawnProcess: defaults.spawn,
    })
  }

  return {
    specificationVersion: "v3",
    provider: providerName,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(callOptions) {
      const result = await execute(callOptions)
      return {
        content: [{ type: "text", text: result.result }],
        finishReason: finishReason(result),
        usage: mapClaudeUsage(result),
        warnings: [],
        response: {
          id: result.uuid,
          modelId: modelID,
        },
      }
    },
    async doStream(callOptions) {
      const streamAbort = new AbortController()
      const abortFromParent = () => streamAbort.abort(callOptions.abortSignal?.reason)
      if (callOptions.abortSignal?.aborted) abortFromParent()
      else callOptions.abortSignal?.addEventListener("abort", abortFromParent, { once: true })
      let cancelled = false

      return {
        stream: new ReadableStream({
          async start(controller) {
            const openTextBlocks = new Map()
            let textSequence = 0
            let emittedText = false
            const enqueue = (part) => {
              if (!cancelled) controller.enqueue(part)
            }
            const startText = (index) => {
              const existing = openTextBlocks.get(index)
              if (existing) return existing
              const id = `claude-text-${++textSequence}`
              openTextBlocks.set(index, id)
              enqueue({ type: "text-start", id })
              return id
            }
            const endText = (index) => {
              const id = openTextBlocks.get(index)
              if (!id) return
              enqueue({ type: "text-end", id })
              openTextBlocks.delete(index)
            }
            const endAllText = () => {
              for (const index of [...openTextBlocks.keys()]) endText(index)
            }
            const onMessage = (message) => {
              if (cancelled || message?.type !== "stream_event" || message.parent_tool_use_id !== null) return
              const event = message.event
              if (event?.type === "content_block_start" && event.content_block?.type === "text") {
                const id = startText(event.index)
                if (event.content_block.text) {
                  emittedText = true
                  enqueue({ type: "text-delta", id, delta: event.content_block.text })
                }
                return
              }
              if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
                const id = startText(event.index)
                if (event.delta.text) {
                  emittedText = true
                  enqueue({ type: "text-delta", id, delta: event.delta.text })
                }
                return
              }
              if (event?.type === "content_block_stop") endText(event.index)
            }

            try {
              enqueue({ type: "stream-start", warnings: [] })
              const result = await execute(callOptions, streamAbort.signal, onMessage)
              endAllText()
              if (!emittedText) {
                const id = startText("fallback")
                enqueue({ type: "text-delta", id, delta: result.result })
                endText("fallback")
              }
              const id = result.uuid ?? "claude-agent-result"
              enqueue({ type: "response-metadata", id, modelId: modelID })
              enqueue({
                type: "finish",
                usage: mapClaudeUsage(result),
                finishReason: finishReason(result),
              })
              if (!cancelled) controller.close()
            } catch (error) {
              if (!cancelled) {
                endAllText()
                controller.enqueue({ type: "error", error })
                controller.close()
              }
            } finally {
              callOptions.abortSignal?.removeEventListener("abort", abortFromParent)
            }
          },
          cancel(reason) {
            cancelled = true
            streamAbort.abort(reason)
          },
        }),
      }
    },
  }
}

export function createClaudeAgent(options = {}) {
  const providerName = options.name ?? "claude-agent"
  return {
    languageModel(modelID = CLAUDE_MODEL) {
      return languageModel(modelID, providerName, options)
    },
  }
}
