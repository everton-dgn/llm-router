import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk"

import {
  CLAUDE_MODEL,
  CLAUDE_TIMEOUT_MS,
  createClaudeMessageStream,
  runClaudeAgent,
} from "../lib/claude_agent.mjs"
import {
  boundedClaudeJSONBytes,
  claudeContentBlocksFromProviderFile,
  normalizeClaudeConversationContent,
  visibleClaudeConversationText,
} from "../lib/claude_context.mjs"

// This guards transport memory only. OpenCode owns the 200k-token compaction
// threshold, so the byte ceiling must not truncate ordinary context first.
export const CLAUDE_MAX_INPUT_BYTES = 2 * 1024 * 1024
export const CLAUDE_DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

function currentUserContentParts(part) {
  if (!part || typeof part !== "object" || typeof part.type !== "string") {
    throw new Error("Claude adapter received an unknown user message part")
  }
  if (part.type === "file") {
    return claudeContentBlocksFromProviderFile(part, { maxBytes: CLAUDE_MAX_INPUT_BYTES })
  }
  if (["tool-call", "tool-result", "tool-approval-response"].includes(part.type)) {
    throw new Error(`Claude adapter does not accept ${part.type} history`)
  }
  if (part.type === "text") {
    if (typeof part.text !== "string") {
      throw new Error("Claude adapter received invalid user text")
    }
    return part.text ? [{ type: "text", text: part.text }] : []
  }
  throw new Error(`Claude adapter does not support user message part: ${part.type}`)
}

function inputTooLarge() {
  throw new Error(`Claude input exceeds the ${CLAUDE_MAX_INPUT_BYTES}-byte input limit`)
}

function validateSafeConversation(conversation, currentContent) {
  if (!Array.isArray(conversation) || conversation.length === 0) {
    throw new Error("Claude adapter received invalid safe conversation context")
  }
  const normalized = []
  let measuredBytes = 2
  for (const message of conversation) {
    if (
      !message
      || !["user", "assistant"].includes(message.role)
    ) {
      throw new Error("Claude adapter received invalid safe conversation context")
    }
    const content = normalizeClaudeConversationContent(message.content, {
      maxBytes: CLAUDE_MAX_INPUT_BYTES,
    })
    if (message.role === "assistant" && content.some((part) => part.type !== "text")) {
      throw new Error("Claude adapter received non-text assistant history")
    }
    const normalizedMessage = {
      role: message.role,
      content,
    }
    const sdkMessage = {
      type: "user",
      message: normalizedMessage,
      parent_tool_use_id: null,
      ...(message.role === "user" ? { origin: { kind: "human" } } : {}),
      shouldQuery: false,
    }
    const messageBytes = boundedClaudeJSONBytes(sdkMessage, CLAUDE_MAX_INPUT_BYTES)
    if (messageBytes > CLAUDE_MAX_INPUT_BYTES) inputTooLarge()
    measuredBytes += (normalized.length > 0 ? 1 : 0) + messageBytes
    if (measuredBytes > CLAUDE_MAX_INPUT_BYTES) inputTooLarge()
    normalized.push(normalizedMessage)
  }
  const last = normalized.at(-1)
  const currentText = visibleClaudeConversationText(currentContent)
  const safeText = last ? visibleClaudeConversationText(last.content) : ""
  if (
    last?.role !== "user"
    || safeText !== currentText
    || (!currentText && JSON.stringify(last.content) !== JSON.stringify(currentContent))
  ) {
    throw new Error("Claude safe conversation does not match the current user message")
  }
  normalized[normalized.length - 1] = { role: "user", content: currentContent }
  return normalized
}

export function serializeClaudePrompt(prompt, safeConversation) {
  if (!Array.isArray(prompt)) throw new Error("Claude adapter prompt must be an array")

  const currentUserIndex = prompt.findLastIndex((message) => message?.role === "user")
  if (currentUserIndex === -1) {
    throw new Error("Claude adapter prompt contains no current user message")
  }
  const currentUser = prompt[currentUserIndex]

  if (!Array.isArray(currentUser.content)) {
    throw new Error("Claude adapter received an invalid current user message")
  }

  const currentContent = []
  let currentContentBytes = 2
  for (const part of currentUser.content) {
    for (const block of currentUserContentParts(part)) {
      const blockBytes = boundedClaudeJSONBytes(block, CLAUDE_MAX_INPUT_BYTES)
      currentContentBytes += (currentContent.length > 0 ? 1 : 0) + blockBytes
      if (blockBytes > CLAUDE_MAX_INPUT_BYTES || currentContentBytes > CLAUDE_MAX_INPUT_BYTES) {
        inputTooLarge()
      }
      currentContent.push(block)
    }
  }
  if (currentContent.length === 0) {
    throw new Error("Claude adapter prompt contains no current user content")
  }

  const transcript = safeConversation === undefined
    ? [{ role: "user", content: currentContent }]
    : validateSafeConversation(safeConversation, currentContent)

  const sdkMessages = transcript.map((message, index) => ({
    type: "user",
    message,
    parent_tool_use_id: null,
    ...(message.role === "user" ? { origin: { kind: "human" } } : {}),
    ...(index < transcript.length - 1 ? { shouldQuery: false } : {}),
  }))
  const inputBytes = boundedClaudeJSONBytes(sdkMessages, CLAUDE_MAX_INPUT_BYTES)
  if (inputBytes > CLAUDE_MAX_INPUT_BYTES) {
    inputTooLarge()
  }

  return {
    request: createClaudeMessageStream(sdkMessages),
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
  const maxOutputBytes = provided.maxOutputBytes
    ?? defaults.maxOutputBytes
    ?? CLAUDE_DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error("Claude adapter maxOutputBytes must be a positive integer")
  }
  const maxTurns = provided.maxTurns ?? defaults.maxTurns
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error("Claude adapter maxTurns must be a positive integer")
  }
  return {
    cwd,
    claudePath,
    permissionCallback: provided.permissionCallback ?? defaults.permissionCallback,
    permissionProfile: provided.permissionProfile ?? defaults.permissionProfile,
    permissionTimeoutMs: provided.permissionTimeoutMs ?? defaults.permissionTimeoutMs,
    safeConversation: provided.safeConversation,
    timeoutMs: provided.timeoutMs ?? defaults.timeoutMs ?? CLAUDE_TIMEOUT_MS,
    maxOutputBytes,
    maxTurns,
  }
}

function limitedMessageHandler(maxOutputBytes, onMessage) {
  let streamedBytes = 0
  const exceeded = () => new Error(
    `Claude output exceeded maxOutputBytes ${maxOutputBytes}`,
  )

  return async (message) => {
    const remaining = Math.max(0, maxOutputBytes - streamedBytes)
    streamedBytes += boundedClaudeJSONBytes(message, remaining)
    if (streamedBytes > maxOutputBytes) throw exceeded()
    await onMessage?.(message)
  }
}

function callWarnings(callOptions, safeConversation) {
  const warnings = []
  if (callOptions.maxOutputTokens !== undefined) {
    warnings.push({
      type: "unsupported",
      feature: "maxOutputTokens",
      details: "Claude Agent SDK does not expose an enforceable output-token limit",
    })
  }
  if (safeConversation?.contextMetadata?.truncated === true) {
    warnings.push({
      type: "other",
      message: `Claude context was truncated by ${safeConversation.contextMetadata.droppedMessages} messages before serialization`,
    })
  }
  return warnings
}

function languageModel(modelID, providerName, defaults) {
  async function execute(callOptions, signal = callOptions.abortSignal, onMessage) {
    const runtime = runtimeOptions(callOptions, providerName, defaults)
    const prompt = serializeClaudePrompt(callOptions.prompt, runtime.safeConversation)
    return runClaudeAgent({
      query: defaults.query ?? claudeQuery,
      request: prompt.request,
      cwd: runtime.cwd,
      model: modelID,
      claudePath: runtime.claudePath,
      parentSignal: signal,
      timeoutMs: runtime.timeoutMs,
      onMessage: limitedMessageHandler(runtime.maxOutputBytes, onMessage),
      parentEnv: defaults.parentEnv,
      permissionCallback: runtime.permissionCallback,
      permissionProfile: runtime.permissionProfile,
      permissionTimeoutMs: runtime.permissionTimeoutMs,
      maxTurns: runtime.maxTurns,
    })
  }

  return {
    specificationVersion: "v3",
    provider: providerName,
    modelId: modelID,
    supportedUrls: {},
    async doGenerate(callOptions) {
      const warnings = callWarnings(
        callOptions,
        callOptions.providerOptions?.[providerName]?.safeConversation,
      )
      const result = await execute(callOptions)
      return {
        content: [{ type: "text", text: result.result }],
        finishReason: finishReason(result),
        usage: mapClaudeUsage(result),
        warnings,
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
      const warnings = callWarnings(
        callOptions,
        callOptions.providerOptions?.[providerName]?.safeConversation,
      )

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
              enqueue({ type: "stream-start", warnings })
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
