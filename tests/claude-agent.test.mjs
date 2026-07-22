import assert from "node:assert/strict"
import test from "node:test"

import {
  CLAUDE_SYSTEM_PROMPT,
  buildClaudeAgentOptions,
  buildClaudeEnvironment,
  consumeClaudeResult,
  runClaudeAgent,
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

function queryHarness(factory) {
  const calls = []
  const queries = []
  const query = (parameters) => {
    calls.push(parameters)
    const iterator = factory(parameters)
    let closed = false
    iterator.close = () => {
      closed = true
      iterator.return?.()
    }
    Object.defineProperty(iterator, "closed", { get: () => closed })
    queries.push(iterator)
    return iterator
  }
  return { calls, queries, query }
}

test("builds Agent SDK options with the local Claude executable and complete tools", () => {
  const abortController = new AbortController()
  const options = buildClaudeAgentOptions({
    abortController,
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-4-8",
  })

  assert.equal(options.abortController, abortController)
  assert.equal(options.cwd, process.cwd())
  assert.equal(options.model, "claude-opus-4-8")
  assert.equal(options.pathToClaudeCodeExecutable, process.execPath)
  assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" })
  assert.equal(options.permissionMode, "auto")
  assert.equal(options.persistSession, false)
  assert.equal(options.includePartialMessages, true)
  assert.deepEqual(options.settingSources, [])
  assert.deepEqual(options.mcpServers, {})
  assert.equal(options.strictMcpConfig, true)
  assert.deepEqual(options.extraArgs, { "no-chrome": null, "safe-mode": null })
  assert.deepEqual(options.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: CLAUDE_SYSTEM_PROMPT,
  })
  assert.match(CLAUDE_SYSTEM_PROMPT, /Use Claude Code built-in tools/)
  assert.doesNotMatch(CLAUDE_SYSTEM_PROMPT, /no tools|Stay read-only/)
})

test("passes only required runtime, Claude authentication, proxy, and TLS variables", () => {
  const parentEnv = {
    HOME: "/safe/home",
    PATH: "/safe/bin",
    TMPDIR: "/safe/tmp",
    LANG: "pt_BR.UTF-8",
    LC_ALL: "pt_BR.UTF-8",
    TERM: "xterm-256color",
    XDG_CONFIG_HOME: "/safe/config",
    ANTHROPIC_API_KEY: "fake-anthropic-token",
    CLAUDE_CODE_OAUTH_TOKEN: "fake-claude-token",
    HTTPS_PROXY: "http://proxy.invalid:8080",
    NO_PROXY: "localhost,127.0.0.1",
    SSL_CERT_FILE: "/safe/ca.pem",
    NODE_EXTRA_CA_CERTS: "/safe/node-ca.pem",
    ZAI_API_KEY: "must-not-reach-claude",
    MINIMAX_API_KEY: "must-not-reach-claude",
    UNRELATED_SECRET: "must-not-reach-claude",
  }

  const env = buildClaudeEnvironment(parentEnv)

  assert.deepEqual(env, {
    HOME: parentEnv.HOME,
    PATH: parentEnv.PATH,
    TMPDIR: parentEnv.TMPDIR,
    LANG: parentEnv.LANG,
    LC_ALL: parentEnv.LC_ALL,
    TERM: parentEnv.TERM,
    XDG_CONFIG_HOME: parentEnv.XDG_CONFIG_HOME,
    ANTHROPIC_API_KEY: parentEnv.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: parentEnv.CLAUDE_CODE_OAUTH_TOKEN,
    HTTPS_PROXY: parentEnv.HTTPS_PROXY,
    NO_PROXY: parentEnv.NO_PROXY,
    SSL_CERT_FILE: parentEnv.SSL_CERT_FILE,
    NODE_EXTRA_CA_CERTS: parentEnv.NODE_EXTRA_CA_CERTS,
  })
  assert.equal("ZAI_API_KEY" in env, false)
  assert.equal("MINIMAX_API_KEY" in env, false)
  assert.equal("UNRELATED_SECRET" in env, false)
})

test("filters exported shell functions even when their names are allowed", () => {
  assert.deepEqual(buildClaudeEnvironment({
    HOME: "/safe/home",
    PATH: "/safe/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "  () { echo exposed; }",
    ANTHROPIC_CUSTOM_AUTH: "() { echo exposed; }",
    "BASH_FUNC_helper%%": "() { echo exposed; }",
  }), {
    HOME: "/safe/home",
    PATH: "/safe/bin",
  })
})

test("rejects invalid Agent SDK options", () => {
  const common = {
    abortController: new AbortController(),
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-4-8",
  }
  assert.throws(() => buildClaudeAgentOptions({ ...common, cwd: "" }), /working directory/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, claudePath: "claude" }), /must be absolute/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, model: "" }), /model/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, abortController: undefined }), /abort controller/)
  assert.throws(() => buildClaudeEnvironment(null), /parent environment/)
})

test("accepts SDK tool events and validates the final result", async () => {
  const received = []
  const result = await consumeClaudeResult((async function* () {
    yield { type: "system", subtype: "init", tools: ["Read", "Edit", "Bash"] }
    yield { type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }
    yield successResult("  final answer  ")
  })(), { onMessage: (message) => received.push(message.type) })

  assert.equal(result.result, "final answer")
  assert.equal(result.uuid, "session-1")
  assert.deepEqual(received, ["system", "assistant", "result"])

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
})

test("runs query once without closing the exhausted SDK query again", async () => {
  const received = []
  const harness = queryHarness(async function* () {
    yield { type: "system", subtype: "init", tools: ["Read", "Edit", "Bash"] }
    yield successResult()
  })

  const result = await runClaudeAgent({
    query: harness.query,
    request: "serialized request",
    cwd: process.cwd(),
    model: "claude-opus-4-8",
    claudePath: process.execPath,
    parentSignal: new AbortController().signal,
    timeoutMs: 1_000,
    onMessage: (message) => received.push(message.type),
  })

  assert.equal(result.result, "done")
  assert.deepEqual(received, ["system", "result"])
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].prompt, "serialized request")
  assert.equal(harness.calls[0].options.cwd, process.cwd())
  assert.equal(harness.calls[0].options.pathToClaudeCodeExecutable, process.execPath)
  assert.equal(harness.queries[0].closed, false)
})

test("propagates parent abort and closes a non-cooperative SDK query", async () => {
  let started
  const entered = new Promise((resolve) => { started = resolve })
  const harness = queryHarness(async function* () {
    started()
    await new Promise(() => {})
  })
  const parent = new AbortController()
  const pending = runClaudeAgent({
    query: harness.query,
    request: "request",
    cwd: process.cwd(),
    claudePath: process.execPath,
    parentSignal: parent.signal,
    timeoutMs: 1_000,
  })

  await entered
  parent.abort(new Error("cancelled"))
  await assert.rejects(pending, /aborted by the OpenCode session/)
  assert.equal(harness.calls[0].options.abortController.signal.aborted, true)
  assert.equal(harness.queries[0].closed, true)
})

test("enforces the timeout even when the SDK query does not settle", async () => {
  const harness = queryHarness(async function* () {
    await new Promise(() => {})
  })
  const startedAt = Date.now()

  await assert.rejects(
    runClaudeAgent({
      query: harness.query,
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      timeoutMs: 20,
    }),
    /timed out after 20ms/,
  )

  assert.ok(Date.now() - startedAt < 500, "deadline waited for a non-cooperative SDK query")
  assert.equal(harness.calls[0].options.abortController.signal.aborted, true)
  assert.equal(harness.queries[0].closed, true)
})

test("reports synchronous query failures and invalid requests", async () => {
  await assert.rejects(
    runClaudeAgent({
      query() {
        throw new Error("SDK startup failed")
      },
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
      timeoutMs: 1_000,
    }),
    /SDK startup failed/,
  )
  await assert.rejects(
    runClaudeAgent({
      query: () => { throw new Error("must not run") },
      request: "",
      cwd: process.cwd(),
      claudePath: process.execPath,
    }),
    /non-empty string/,
  )
  await assert.rejects(
    runClaudeAgent({
      query: undefined,
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
    }),
    /query factory/,
  )
})
