import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"

import {
  CLAUDE_SYSTEM_PROMPT,
  buildClaudeCliInvocation,
  consumeClaudeResult,
  parseClaudeJsonLines,
  runClaudeCli,
} from "../opencode/lib/claude_agent.mjs"

function successResult(result = "done") {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result,
    session_id: "session-1",
    stop_reason: "end_turn",
    total_cost_usd: 0.01,
    num_turns: 1,
    modelUsage: {},
  }
}

function spawnHarness(start, { closeOnKill = true } = {}) {
  const calls = []
  const children = []
  const spawnProcess = (command, args, options) => {
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
      if (closeOnKill) close(null, signal)
      return true
    }

    calls.push({ command, args, options, child })
    children.push(child)
    queueMicrotask(() => start({ child, close, emit }))
    return child
  }

  return { calls, children, spawnProcess }
}

test("builds a tool-free Claude CLI invocation with a constant system prompt", () => {
  const invocation = buildClaudeCliInvocation({
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-4-8",
  })

  assert.equal(invocation.command, process.execPath)
  assert.equal(invocation.options.cwd, process.cwd())
  assert.equal(invocation.options.shell, false)
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"])
  for (const expected of [
    ["-p"],
    ["--input-format", "text"],
    ["--output-format", "stream-json"],
    ["--verbose"],
    ["--include-partial-messages"],
    ["--model", "claude-opus-4-8"],
    ["--permission-mode", "dontAsk"],
    ["--safe-mode"],
    ["--tools", ""],
    ["--strict-mcp-config"],
    ["--mcp-config", '{"mcpServers":{}}'],
    ["--disable-slash-commands"],
    ["--no-chrome"],
    ["--no-session-persistence"],
  ]) {
    const index = invocation.args.indexOf(expected[0])
    assert.notEqual(index, -1, `${expected[0]} is required`)
    if (expected.length === 2) assert.equal(invocation.args[index + 1], expected[1])
  }
  const systemIndex = invocation.args.indexOf("--system-prompt")
  assert.equal(invocation.args[systemIndex + 1], CLAUDE_SYSTEM_PROMPT)
  assert.match(CLAUDE_SYSTEM_PROMPT, /You have no tools/)
  assert.match(CLAUDE_SYSTEM_PROMPT, /no access to files/)
})

test("rejects invalid CLI invocation parameters", () => {
  const common = {
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-4-8",
  }
  assert.throws(() => buildClaudeCliInvocation({ ...common, cwd: "" }), /working directory/)
  assert.throws(() => buildClaudeCliInvocation({ ...common, claudePath: "claude" }), /must be absolute/)
  assert.throws(() => buildClaudeCliInvocation({ ...common, model: "" }), /model/)
})

test("parses chunked JSONL and rejects malformed output", async () => {
  const messages = []
  const valid = (async function* () {
    yield Buffer.from('{"type":"system"}\n{"type":"res')
    yield Buffer.from('ult","subtype":"success","result":"ok"}')
  })()
  for await (const message of parseClaudeJsonLines(valid)) messages.push(message)
  assert.deepEqual(messages, [
    { type: "system" },
    { type: "result", subtype: "success", result: "ok" },
  ])

  await assert.rejects(
    async () => {
      for await (const message of parseClaudeJsonLines((async function* () {
        yield Buffer.from('{"type":bad}\n')
      })())) void message
    },
    /invalid stream JSON on line 1/,
  )
})

test("validates the final CLI result", async () => {
  const result = await consumeClaudeResult((async function* () {
    yield { type: "assistant" }
    yield successResult("  final answer  ")
  })())
  assert.equal(result.result, "final answer")
  assert.equal(result.uuid, "session-1")

  await assert.rejects(
    consumeClaudeResult((async function* () { yield { type: "assistant" } })()),
    /without a result message/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["failed"] }
    })()),
    /error_during_execution: failed/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () { yield { ...successResult("error"), is_error: true } })()),
    /error result/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () { yield successResult("   ") })()),
    /empty response/,
  )
  await assert.rejects(
    consumeClaudeResult((async function* () {
      yield { type: "system", subtype: "init", tools: ["Read"], mcp_servers: [] }
      yield successResult()
    })()),
    /violated the tool-free contract/,
  )
})

test("spawns Claude once, writes the prompt to stdin, and streams JSON messages", async () => {
  const received = []
  const harness = spawnHarness(({ emit, close }) => {
    emit({ type: "system", subtype: "init" })
    emit(successResult())
    close(0)
  })

  const result = await runClaudeCli({
    request: "serialized request",
    cwd: process.cwd(),
    model: "claude-opus-4-8",
    claudePath: process.execPath,
    parentSignal: new AbortController().signal,
    timeoutMs: 1_000,
    onMessage: (message) => received.push(message.type),
    spawnProcess: harness.spawnProcess,
  })

  assert.equal(result.result, "done")
  assert.deepEqual(received, ["system", "result"])
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].command, process.execPath)
  assert.equal(harness.calls[0].child.stdinText, "serialized request")
  assert.equal(harness.calls[0].child.kills.length, 0)
})

test("reports non-zero exit code and bounded stderr", async () => {
  const harness = spawnHarness(({ child, close }) => {
    child.stderr.write("authentication failed")
    close(2)
  })

  await assert.rejects(
    runClaudeCli({
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      timeoutMs: 1_000,
      spawnProcess: harness.spawnProcess,
    }),
    /exited with code 2: authentication failed/,
  )
})

test("rejects invalid JSON emitted by a zero-exit CLI", async () => {
  const harness = spawnHarness(({ child, close }) => {
    child.stdout.write("not-json\n")
    close(0)
  })

  await assert.rejects(
    runClaudeCli({
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      timeoutMs: 1_000,
      spawnProcess: harness.spawnProcess,
    }),
    /invalid stream JSON on line 1/,
  )
})

test("propagates parent abort and terminates the CLI", async () => {
  let markStarted
  const started = new Promise((resolve) => { markStarted = resolve })
  const harness = spawnHarness(() => { markStarted() })
  const parent = new AbortController()
  const pending = runClaudeCli({
    request: "request",
    cwd: process.cwd(),
    claudePath: process.execPath,
    parentSignal: parent.signal,
    timeoutMs: 1_000,
    spawnProcess: harness.spawnProcess,
  })

  await started
  parent.abort()
  await assert.rejects(pending, /aborted by the OpenCode session/)
  assert.deepEqual(harness.children[0].kills, ["SIGTERM"])
})

test("enforces the timeout even when the child ignores termination", async () => {
  const harness = spawnHarness(() => {}, { closeOnKill: false })
  const startedAt = Date.now()

  await assert.rejects(
    runClaudeCli({
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      parentSignal: new AbortController().signal,
      timeoutMs: 20,
      spawnProcess: harness.spawnProcess,
    }),
    /timed out after 20ms/,
  )

  assert.deepEqual(harness.children[0].kills, ["SIGTERM"])
  assert.ok(Date.now() - startedAt < 500, "deadline waited for a non-cooperative child")
})

test("reports synchronous spawn failures", async () => {
  await assert.rejects(
    runClaudeCli({
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      timeoutMs: 1_000,
      spawnProcess() {
        throw new Error("spawn denied")
      },
    }),
    /failed to start: spawn denied/,
  )
})
