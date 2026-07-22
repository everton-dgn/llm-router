import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  CLAUDE_MAX_INPUT_BYTES,
  createClaudeAgent,
  mapClaudeUsage,
  serializeClaudePrompt,
} from "../opencode/providers/claude_agent_provider.mjs"

function successResult(result = "final answer") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: "result-1",
    stop_reason: "end_turn",
    total_cost_usd: 0.25,
    num_turns: 2,
    modelUsage: {
      "claude-opus-4-8": {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
    },
  }
}

function spawnHarness(start) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    child.stdinText = ""
    child.kills = []
    child.stdin.on("data", (chunk) => { child.stdinText += chunk.toString("utf8") })

    let closed = false
    const close = (code = 0, signal = null) => {
      if (closed) return
      closed = true
      child.exitCode = code
      child.signalCode = signal
      child.stdout.end()
      child.stderr.end()
      child.emit("close", code, signal)
    }
    const emit = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
    child.kill = (signal) => {
      child.kills.push(signal)
      close(null, signal)
      return true
    }

    calls.push({ command, args, options, child })
    queueMicrotask(() => start({ child, close, emit }))
    return child
  }
  return { calls, spawn }
}

function successfulHarness(result = successResult()) {
  return spawnHarness(({ emit, close }) => {
    emit({ type: "assistant" })
    emit(result)
    close(0)
  })
}

function callOptions(prompt, cwd = process.cwd()) {
  return {
    prompt,
    providerOptions: {
      "claude-agent": {
        cwd,
        claudePath: process.execPath,
        timeoutMs: 1_000,
      },
    },
    tools: [{ type: "function", name: "external_tool", inputSchema: { type: "object" } }],
    abortSignal: new AbortController().signal,
  }
}

const textPrompt = [
  { role: "system", content: "Stay read-only." },
  { role: "user", content: [{ type: "text", text: "pedido original" }] },
  { role: "assistant", content: [{ type: "text", text: "contexto anterior" }] },
  { role: "user", content: [{ type: "text", text: "continue" }] },
]

test("discards system text and sends only the current user message", () => {
  const serialized = serializeClaudePrompt(textPrompt)
  assert.deepEqual(serialized, { request: "continue" })
})

test("ignores sensitive attachments and tool history before the current user message", () => {
  const serialized = serializeClaudePrompt([
    { role: "system", content: "Allowed system text." },
    { role: "user", content: [{ type: "file", data: "OLD_FILE_SECRET_7f91", mediaType: "text/plain" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: { secret: "OLD_CALL_SECRET_3ab2" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "OLD_RESULT_SECRET_4dc3" } }] },
    { role: "user", content: [{ type: "text", text: "current request" }] },
  ])

  assert.equal(serialized.request, "current request")
  assert.equal(serialized.request.includes("SECRET"), false)
  assert.equal("systemPrompt" in serialized, false)
})

test("fails closed on unsafe parts in the current user message", () => {
  assert.throws(
    () => serializeClaudePrompt([{ role: "user", content: [{ type: "file", data: "x", mediaType: "text/plain" }] }]),
    /does not accept file attachments/,
  )
  assert.throws(
    () => serializeClaudePrompt([{ role: "user", content: [{ type: "tool-call", toolCallId: "1", toolName: "read", input: {} }] }]),
    /does not accept tool-call/,
  )
  assert.throws(
    () => serializeClaudePrompt([{ role: "user", content: [{ type: "tool-result", toolCallId: "1", toolName: "read", output: { type: "text", value: "secret" } }] }]),
    /does not accept tool-result/,
  )
  assert.throws(
    () => serializeClaudePrompt([{ role: "user", content: [{ type: "mystery" }] }]),
    /does not support user message part/,
  )
})

test("rejects oversized input before spawning Claude", async () => {
  let spawnCalls = 0
  const model = createClaudeAgent({
    spawn: () => {
      spawnCalls += 1
      throw new Error("spawn must not be called")
    },
  }).languageModel("claude-opus-4-8")
  const oversized = [{
    role: "user",
    content: [{ type: "text", text: "x".repeat(CLAUDE_MAX_INPUT_BYTES + 1) }],
  }]

  await assert.rejects(
    model.doGenerate(callOptions(oversized)),
    /exceeds the 131072-byte input limit/,
  )
  assert.equal(spawnCalls, 0)
})

test("terminates Claude when the final output exceeds maxOutputTokens", async () => {
  const harness = spawnHarness(({ emit }) => {
    emit(successResult("eleven-byte"))
  })
  const model = createClaudeAgent({ spawn: harness.spawn }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.maxOutputTokens = 10

  await assert.rejects(model.doGenerate(options), /exceeded maxOutputTokens 10/)
  assert.deepEqual(harness.calls[0].child.kills, ["SIGTERM"])
})

test("stops progressive output before emitting a delta above maxOutputTokens", async () => {
  const harness = spawnHarness(({ emit }) => {
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    })
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "123456" } },
    })
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "78901" } },
    })
  })
  const model = createClaudeAgent({ spawn: harness.spawn }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.maxOutputTokens = 10
  const response = await model.doStream(options)
  const parts = []
  for await (const part of response.stream) parts.push(part)

  assert.deepEqual(parts.map((part) => part.type), [
    "stream-start",
    "text-start",
    "text-delta",
    "text-end",
    "error",
  ])
  assert.equal(parts[2].delta, "123456")
  assert.match(parts.at(-1).error.message, /exceeded maxOutputTokens 10/)
  assert.deepEqual(harness.calls[0].child.kills, ["SIGTERM"])
})

test("implements LanguageModelV3 generation through the Claude CLI", async () => {
  const harness = successfulHarness()
  const provider = createClaudeAgent({ name: "claude-agent", spawn: harness.spawn })
  const model = provider.languageModel("claude-opus-4-8")

  assert.equal(model.specificationVersion, "v3")
  assert.equal(model.provider, "claude-agent")
  assert.equal(model.modelId, "claude-opus-4-8")
  assert.deepEqual(model.supportedUrls, {})

  const generated = await model.doGenerate(callOptions(textPrompt))
  assert.deepEqual(generated.content, [{ type: "text", text: "final answer" }])
  assert.deepEqual(generated.finishReason, { unified: "stop", raw: "end_turn" })
  assert.equal(generated.usage.inputTokens.total, 15)
  assert.equal(generated.usage.outputTokens.total, 20)

  const received = harness.calls[0]
  assert.equal(received.options.cwd, process.cwd())
  assert.equal(received.child.stdinText, "continue")
  assert.equal(received.args[received.args.indexOf("--tools") + 1], "")
  assert.equal(received.args.includes("external_tool"), false)
  assert.equal(received.args.join("\n").includes("Stay read-only."), false)
  assert.equal(received.child.stdinText.includes("Stay read-only."), false)
})

test("streams CLI text deltas before the final result supplies usage", async () => {
  let releaseResult
  const resultGate = new Promise((resolve) => { releaseResult = resolve })
  let markDelta
  const deltaWritten = new Promise((resolve) => { markDelta = resolve })
  const harness = spawnHarness(async ({ emit, close }) => {
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    })
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "live delta" } },
    })
    markDelta()
    await resultGate
    emit({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_stop", index: 0 },
    })
    emit(successResult("live delta"))
    close(0)
  })
  const model = createClaudeAgent({ spawn: harness.spawn }).languageModel("claude-opus-4-8")
  const response = await model.doStream(callOptions(textPrompt))
  const reader = response.stream.getReader()

  await deltaWritten
  assert.deepEqual((await reader.read()).value, { type: "stream-start", warnings: [] })
  const start = (await reader.read()).value
  const delta = (await reader.read()).value
  assert.equal(start.type, "text-start")
  assert.deepEqual(delta, { type: "text-delta", id: start.id, delta: "live delta" })

  releaseResult()
  const parts = [start, delta]
  while (true) {
    const item = await reader.read()
    if (item.done) break
    parts.push(item.value)
  }
  assert.deepEqual(parts.map((part) => part.type), [
    "text-start",
    "text-delta",
    "text-end",
    "response-metadata",
    "finish",
  ])
  assert.equal(parts.at(-1).usage.outputTokens.total, 20)
})

test("requires cwd and exposes CLI process failures as stream errors", async () => {
  const harness = successfulHarness()
  const model = createClaudeAgent({ spawn: harness.spawn, claudePath: process.execPath }).languageModel("claude-opus-4-8")
  await assert.rejects(
    model.doGenerate({ prompt: textPrompt, providerOptions: {} }),
    /requires a workspace cwd/,
  )
  assert.equal(harness.calls.length, 0)

  const failed = spawnHarness(({ child, close }) => {
    child.stderr.write("authentication failed")
    close(3)
  })
  const failedModel = createClaudeAgent({ spawn: failed.spawn }).languageModel("claude-opus-4-8")
  const response = await failedModel.doStream(callOptions(textPrompt))
  const parts = []
  for await (const part of response.stream) parts.push(part)
  assert.deepEqual(parts.map((part) => part.type), ["stream-start", "error"])
  assert.match(parts[1].error.message, /exited with code 3: authentication failed/)
})

test("maps aggregate model usage to the AI SDK contract", () => {
  const usage = mapClaudeUsage(successResult())
  assert.deepEqual(usage.inputTokens, {
    total: 15,
    noCache: 10,
    cacheRead: 3,
    cacheWrite: 2,
  })
  assert.deepEqual(usage.outputTokens, {
    total: 20,
    text: 20,
    reasoning: undefined,
  })
  assert.deepEqual(usage.raw, { totalCostUsd: 0.25, turns: 2 })
})
