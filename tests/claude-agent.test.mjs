import assert from "node:assert/strict"
import test from "node:test"

import {
  CLAUDE_SYSTEM_PROMPT,
  buildClaudeAgentOptions,
  buildClaudeEnvironment,
  consumeClaudeResult,
  createClaudeMessageStream,
  prepareClaudePermissionPolicy,
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

function structuredRequest(text = "request") {
  return createClaudeMessageStream([{
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  }])
}

test("accepts exactly one querying user turn in the structured message stream", () => {
  const historicalUser = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "history" }] },
    parent_tool_use_id: null,
    origin: { kind: "human" },
    shouldQuery: false,
  }
  const historicalAssistant = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    parent_tool_use_id: null,
  }
  const current = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "current" }] },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  }

  assert.doesNotThrow(() => createClaudeMessageStream([
    historicalUser,
    historicalAssistant,
    current,
  ]))
  assert.throws(
    () => createClaudeMessageStream([{ ...historicalUser, shouldQuery: undefined }, current]),
    /historical SDKUserMessage must set shouldQuery to false/,
  )
  assert.throws(
    () => createClaudeMessageStream([{ ...current, shouldQuery: false }]),
    /final SDKUserMessage must query as the user/,
  )
})

// Claude Code parses streaming input line by line and rejects a user envelope
// whose inner role is "assistant", which broke every handoff that followed an
// assistant turn.
test("rejects an assistant turn disguised as a user envelope", () => {
  const current = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "current" }] },
    parent_tool_use_id: null,
    origin: { kind: "human" },
  }

  assert.throws(
    () => createClaudeMessageStream([
      {
        type: "user",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        parent_tool_use_id: null,
        shouldQuery: false,
      },
      current,
    ]),
    /invalid SDKUserMessage/,
  )
  assert.throws(
    () => createClaudeMessageStream([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
        parent_tool_use_id: null,
        shouldQuery: false,
      },
      current,
    ]),
    /assistant SDKMessage must replay as history/,
  )
  assert.throws(
    () => createClaudeMessageStream([{
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      parent_tool_use_id: null,
    }]),
    /assistant SDKMessage must replay as history/,
  )
})

test("builds Agent SDK options with the local Claude executable and complete tools", () => {
  const abortController = new AbortController()
  const options = buildClaudeAgentOptions({
    abortController,
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-5",
    maxTurns: 7,
  })

  assert.equal(options.abortController, abortController)
  assert.equal(options.cwd, process.cwd())
  assert.equal(options.model, "claude-opus-5")
  assert.equal(options.maxTurns, 7)
  assert.equal(options.pathToClaudeCodeExecutable, process.execPath)
  assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" })
  assert.equal(options.permissionMode, "auto")
  assert.equal(typeof options.canUseTool, "function")
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
  assert.equal("effort" in options, false)
})

test("forwards the configured reasoning effort to the Agent SDK", () => {
  const options = buildClaudeAgentOptions({
    abortController: new AbortController(),
    cwd: process.cwd(),
    claudePath: process.execPath,
    model: "claude-opus-5",
    effort: "xhigh",
  })

  assert.equal(options.effort, "xhigh")
  assert.equal(
    buildClaudeAgentOptions({
      abortController: new AbortController(),
      cwd: process.cwd(),
      claudePath: process.execPath,
      model: "claude-opus-5",
      claudeConfigDir: "/safe/home/.claude",
      parentEnv: { HOME: "/safe/home", PATH: "/safe/bin" },
    }).env.CLAUDE_CONFIG_DIR,
    "/safe/home/.claude",
  )
  assert.throws(
    () => buildClaudeAgentOptions({
      abortController: new AbortController(),
      cwd: process.cwd(),
      claudePath: process.execPath,
      model: "claude-opus-5",
      effort: "  ",
    }),
    /effort must be a non-empty string/,
  )
})

test("prepares a provider permission profile without replacing native tools", async () => {
  const callbackCalls = []
  const policy = prepareClaudePermissionPolicy({
    permissionProfile: {
      mode: "default",
      default: "ask",
      tools: {
        Bash: "deny",
        Edit: "ask",
        Read: "allow",
      },
    },
    permissionCallback: async (toolName, input, options) => {
      callbackCalls.push({ toolName, input, options })
      return { behavior: "allow", updatedInput: { ...input, reviewed: true } }
    },
    permissionTimeoutMs: 100,
  })

  assert.equal(policy.permissionMode, "default")
  assert.equal("allowedTools" in policy, false)
  assert.deepEqual(policy.disallowedTools, ["Bash"])
  assert.deepEqual(policy.sandbox, { autoAllowBashIfSandboxed: false })
  assert.deepEqual(policy.settings, {
    permissions: {
      allow: ["Read"],
      ask: ["*"],
      defaultMode: "default",
      deny: ["Bash"],
    },
  })

  const context = {
    requestId: "permission-1",
    signal: new AbortController().signal,
    toolUseID: "tool-1",
  }
  assert.deepEqual(await policy.canUseTool("Read", { path: "README.md" }, context), {
    behavior: "allow",
    toolUseID: "tool-1",
  })
  assert.deepEqual(await policy.canUseTool("Bash", { command: "git status" }, context), {
    behavior: "deny",
    message: "Claude tool Bash is denied by the host permission profile",
    toolUseID: "tool-1",
  })
  assert.deepEqual(await policy.canUseTool("Edit", { path: "README.md" }, context), {
    behavior: "allow",
    updatedInput: { path: "README.md", reviewed: true },
    toolUseID: "tool-1",
  })
  assert.equal(callbackCalls.length, 1)
  assert.equal(callbackCalls[0].toolName, "Edit")
  assert.notEqual(callbackCalls[0].options.signal, context.signal)
})

test("fails closed when a permission callback is absent, times out, throws, or is cancelled", async () => {
  const context = {
    requestId: "permission-2",
    signal: new AbortController().signal,
    toolUseID: "tool-2",
  }
  const absent = prepareClaudePermissionPolicy({
    permissionProfile: { default: "ask" },
  })
  assert.deepEqual(await absent.canUseTool("Edit", {}, context), {
    behavior: "deny",
    message: "Claude tool Edit requires approval, but no host permission callback is configured",
    toolUseID: "tool-2",
  })

  const timedOut = prepareClaudePermissionPolicy({
    permissionProfile: { default: "ask" },
    permissionCallback: async () => new Promise(() => {}),
    permissionTimeoutMs: 10,
  })
  const startedAt = Date.now()
  assert.deepEqual(await timedOut.canUseTool("Edit", {}, context), {
    behavior: "deny",
    message: "Claude tool Edit approval timed out after 10ms",
    toolUseID: "tool-2",
  })
  assert.ok(Date.now() - startedAt < 500)

  const failed = prepareClaudePermissionPolicy({
    permissionProfile: { default: "ask" },
    permissionCallback: async () => { throw new Error("callback secret") },
  })
  assert.deepEqual(await failed.canUseTool("Edit", {}, context), {
    behavior: "deny",
    message: "Claude tool Edit approval failed closed",
    toolUseID: "tool-2",
  })

  const controller = new AbortController()
  controller.abort(new Error("cancelled"))
  const cancelled = prepareClaudePermissionPolicy({
    permissionProfile: { default: "ask" },
    permissionCallback: async () => ({ behavior: "allow" }),
  })
  assert.deepEqual(await cancelled.canUseTool("Edit", {}, {
    ...context,
    signal: controller.signal,
  }), {
    behavior: "deny",
    message: "Claude tool Edit approval was cancelled",
    toolUseID: "tool-2",
  })

  const inFlightController = new AbortController()
  let callbackSignal
  let callbackStarted
  const started = new Promise((resolve) => { callbackStarted = resolve })
  const inFlight = prepareClaudePermissionPolicy({
    permissionProfile: { default: "ask" },
    permissionCallback: async (_toolName, _input, options) => {
      callbackSignal = options.signal
      callbackStarted()
      return new Promise(() => {})
    },
  })
  const pending = inFlight.canUseTool("Edit", {}, {
    ...context,
    signal: inFlightController.signal,
  })
  await started
  inFlightController.abort(new Error("cancelled in flight"))
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "Claude tool Edit approval was cancelled",
    toolUseID: "tool-2",
  })
  assert.equal(callbackSignal.aborted, true)
})

test("forces callback-only permission handling through an SDK ask rule", async () => {
  const policy = prepareClaudePermissionPolicy({
    permissionCallback: async () => "allow",
  })

  assert.equal(policy.permissionMode, "default")
  assert.deepEqual(policy.sandbox, { autoAllowBashIfSandboxed: false })
  assert.deepEqual(policy.settings, {
    permissions: {
      allow: [],
      ask: ["*"],
      defaultMode: "default",
      deny: [],
    },
  })
})

test("implements default allow without an ignored wildcard and rejects shadowing modes", async () => {
  const policy = prepareClaudePermissionPolicy({
    permissionProfile: {
      default: "allow",
      tools: { Bash: "deny", Edit: "ask", Read: "allow" },
    },
    permissionCallback: async () => "deny",
  })

  assert.deepEqual(policy.settings, {
    permissions: {
      allow: ["Read"],
      ask: ["Edit"],
      defaultMode: "default",
      deny: ["Bash"],
    },
  })
  assert.deepEqual(await policy.canUseTool("Glob", {}, {
    requestId: "permission-allow",
    signal: new AbortController().signal,
    toolUseID: "tool-allow",
  }), {
    behavior: "allow",
    toolUseID: "tool-allow",
  })

  for (const mode of ["auto", "dontAsk", "plan"]) {
    assert.throws(
      () => prepareClaudePermissionPolicy({
        permissionProfile: { mode, default: "allow" },
      }),
      /cannot enforce default allow/,
    )
  }
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

// OpenCode starts from a desktop app whose environment has no CLAUDE_CONFIG_DIR,
// so Claude Code used to read a profile with no session and report the login as
// expired on every handoff.
test("pins the configured Claude profile directory in the child environment", () => {
  const parentEnv = { HOME: "/safe/home", PATH: "/safe/bin" }

  assert.deepEqual(buildClaudeEnvironment(parentEnv, { configDir: "/safe/home/.claude" }), {
    HOME: "/safe/home",
    PATH: "/safe/bin",
    CLAUDE_CONFIG_DIR: "/safe/home/.claude",
  })
  assert.deepEqual(
    buildClaudeEnvironment(
      { ...parentEnv, CLAUDE_CONFIG_DIR: "/shell/profile" },
      { configDir: "/safe/home/.claude" },
    ).CLAUDE_CONFIG_DIR,
    "/safe/home/.claude",
  )
  assert.equal("CLAUDE_CONFIG_DIR" in buildClaudeEnvironment(parentEnv), false)
  assert.throws(
    () => buildClaudeEnvironment(parentEnv, { configDir: "relative/.claude" }),
    /config directory must be an absolute path/,
  )
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
    model: "claude-opus-5",
  }
  assert.throws(() => buildClaudeAgentOptions({ ...common, cwd: "" }), /working directory/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, claudePath: "claude" }), /must be absolute/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, model: "" }), /model/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, abortController: undefined }), /abort controller/)
  assert.throws(() => buildClaudeAgentOptions({ ...common, maxTurns: 0 }), /maxTurns/)
  assert.throws(
    () => buildClaudeAgentOptions({ ...common, permissionProfile: { mode: "bypassPermissions" } }),
    /mode is unsupported/,
  )
  assert.throws(
    () => buildClaudeAgentOptions({ ...common, permissionProfile: { tools: { Bash: "maybe" } } }),
    /invalid tool rule/,
  )
  assert.throws(
    () => buildClaudeAgentOptions({
      ...common,
      permissionProfile: { default: "allow", tools: { "Bash(git push *)": "ask" } },
    }),
    /exact tool names/,
  )
  assert.throws(
    () => buildClaudeAgentOptions({
      ...common,
      permissionProfile: { mode: "dontAsk", default: "ask" },
    }),
    /dontAsk cannot enforce host permission profiles/,
  )
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
    request: structuredRequest("serialized request"),
    cwd: process.cwd(),
    model: "claude-opus-5",
    claudePath: process.execPath,
    parentSignal: new AbortController().signal,
    timeoutMs: 1_000,
    onMessage: (message) => received.push(message.type),
  })

  assert.equal(result.result, "done")
  assert.deepEqual(received, ["system", "result"])
  assert.equal(harness.calls.length, 1)
  assert.equal(typeof harness.calls[0].prompt[Symbol.asyncIterator], "function")
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
    request: structuredRequest(),
    cwd: process.cwd(),
    model: "claude-opus-5",
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
      request: structuredRequest(),
      cwd: process.cwd(),
      model: "claude-opus-5",
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
      request: structuredRequest(),
      cwd: process.cwd(),
      model: "claude-opus-5",
      claudePath: process.execPath,
      timeoutMs: 1_000,
    }),
    /SDK startup failed/,
  )
  await assert.rejects(
    runClaudeAgent({
      query: () => { throw new Error("must not run") },
      request: "request",
      cwd: process.cwd(),
      claudePath: process.execPath,
    }),
    /AsyncIterable of SDKUserMessage/,
  )
  await assert.rejects(
    runClaudeAgent({
      query: undefined,
      request: structuredRequest(),
      cwd: process.cwd(),
      model: "claude-opus-5",
      claudePath: process.execPath,
    }),
    /query factory/,
  )
})
