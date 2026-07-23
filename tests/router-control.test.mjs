import assert from "node:assert/strict"
import test from "node:test"

import {
  ROUTER_CONTROL_METADATA_KEY,
  createRouterControlRuntime,
} from "../opencode/lib/router_control.mjs"
import { createRouterControl } from "../opencode/providers/router_control_provider.mjs"

const restrictedPolicy = {
  profile: "restricted",
  source: "session",
  selector: "explicit",
  permissions: [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
  ],
  limits: { max_steps: 2, max_tool_calls: 2, max_child_depth: 1 },
}

function response(data) {
  return { data }
}

function fakeSessions(initial = {}) {
  const sessions = structuredClone(initial)
  const updates = []
  let childSequence = 0
  return {
    sessions,
    updates,
    client: {
      async get({ sessionID }) {
        return response(structuredClone(sessions[sessionID]))
      },
      async update({ sessionID, metadata, permission }) {
        sessions[sessionID] ??= { id: sessionID, metadata: {} }
        if (metadata !== undefined) sessions[sessionID].metadata = structuredClone(metadata)
        if (permission !== undefined) sessions[sessionID].permission = structuredClone(permission)
        updates.push({ sessionID, metadata, permission })
        return response(structuredClone(sessions[sessionID]))
      },
      async create({ parentID, title, agent, permission }) {
        const id = `child-${++childSequence}`
        sessions[id] = { id, parentID, title, agent, permission, metadata: {} }
        return response(structuredClone(sessions[id]))
      },
    },
  }
}

test("router control provider answers locally without a model call", async () => {
  const model = createRouterControl().languageModel("control")
  const result = await model.doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "Router: adaptive | profile: native" }] }],
  })

  assert.deepEqual(result.content, [{ type: "text", text: "Router: adaptive | profile: native" }])
  assert.equal(result.usage.inputTokens.total, 0)
  assert.equal(result.usage.outputTokens.total, 0)
})

test("commands persist routing mode and explicit profile, then apply real session permissions", async () => {
  const store = fakeSessions({
    "session-1": { id: "session-1", metadata: {} },
  })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: (_policy, { sessionOverride }) => ({
      ...restrictedPolicy,
      profile: sessionOverride ?? "native",
      permissions: sessionOverride === "restricted" ? restrictedPolicy.permissions : [],
    }),
    notify: async () => {},
  })
  const output = { parts: [] }

  await runtime.commandBefore({
    command: "router-auto",
    sessionID: "session-1",
    arguments: "",
  }, output)
  await runtime.commandBefore({
    command: "router-restricted",
    sessionID: "session-1",
    arguments: "",
  }, output)

  assert.deepEqual(store.sessions["session-1"].metadata[ROUTER_CONTROL_METADATA_KEY], {
    schemaVersion: 1,
    sessionID: "session-1",
    mode: "auto",
    profileOverride: "restricted",
  })
  assert.deepEqual(store.sessions["session-1"].permission, restrictedPolicy.permissions)
  assert.match(output.parts[0].text, /mode: auto.*profile: restricted/i)
  assert.equal(await runtime.routingAgent("session-1", "router"), "router-auto")
})

test("router-status reports state without mutating session permissions", async () => {
  const store = fakeSessions({
    "session-1": {
      id: "session-1",
      metadata: {
        [ROUTER_CONTROL_METADATA_KEY]: {
          schemaVersion: 1,
          sessionID: "session-1",
          mode: "adaptive",
        },
      },
      permission: [{ permission: "read", pattern: "*", action: "allow" }],
    },
  })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    notify: async () => {},
  })
  const output = { parts: [] }

  await runtime.commandBefore({
    command: "router-status",
    sessionID: "session-1",
    arguments: "",
  }, output)

  assert.deepEqual(store.updates, [])
  assert.deepEqual(store.sessions["session-1"].permission, [
    { permission: "read", pattern: "*", action: "allow" },
  ])
  assert.match(output.parts[0].text, /^Router status\. mode: adaptive \| profile: restricted$/)
})

test("router-uninstall delegates arguments without reading or mutating session state", async () => {
  const store = fakeSessions({
    "session-1": {
      id: "session-1",
      metadata: {
        [ROUTER_CONTROL_METADATA_KEY]: {
          schemaVersion: 1,
          sessionID: "session-1",
          mode: "pinned",
          profileOverride: "full",
        },
      },
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    },
  })
  const calls = []
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => {
      throw new Error("router-uninstall must not load execution policy")
    },
    resolvePolicy: () => {
      throw new Error("router-uninstall must not resolve execution policy")
    },
    uninstall: async (argumentsText) => {
      calls.push(argumentsText)
      return "Uninstall preview. Run /router-uninstall confirmation-token to continue."
    },
    notify: async () => {
      throw new Error("router-uninstall must not send router-control notifications")
    },
  })
  const output = { parts: [{ type: "text", text: "stale" }] }
  const corePartsReference = output.parts

  await runtime.commandBefore({
    command: "router-uninstall",
    sessionID: "session-1",
    arguments: "  confirmation-token  ",
  }, output)

  assert.deepEqual(calls, ["  confirmation-token  "])
  assert.equal(output.parts, corePartsReference)
  assert.deepEqual(store.updates, [])
  assert.deepEqual(store.sessions["session-1"].metadata[ROUTER_CONTROL_METADATA_KEY], {
    schemaVersion: 1,
    sessionID: "session-1",
    mode: "pinned",
    profileOverride: "full",
  })
  assert.deepEqual(store.sessions["session-1"].permission, [
    { permission: "*", pattern: "*", action: "allow" },
  ])
  assert.deepEqual(output.parts, [{
    type: "text",
    text: "Uninstall preview. Run /router-uninstall confirmation-token to continue.",
  }])
})

test("router-uninstall normalizes missing arguments and rejects invalid responses", async () => {
  const store = fakeSessions()
  const calls = []
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    uninstall: async (argumentsText) => {
      calls.push(argumentsText)
      return calls.length === 1 ? "Uninstall preview" : undefined
    },
  })

  const output = { parts: [] }
  await runtime.commandBefore({
    command: "router-uninstall",
    sessionID: "session-1",
  }, output)
  assert.deepEqual(calls, [""])
  assert.deepEqual(output.parts, [{ type: "text", text: "Uninstall preview" }])

  await assert.rejects(
    runtime.commandBefore({
      command: "router-uninstall",
      sessionID: "session-1",
      arguments: "token",
    }, output),
    /must return a text response/,
  )
})

test("restricted Claude uses OpenCode native permission requests and correlates ask replies", async () => {
  const store = fakeSessions({
    "session-1": {
      id: "session-1",
      metadata: {
        [ROUTER_CONTROL_METADATA_KEY]: {
          schemaVersion: 1,
          sessionID: "session-1",
          mode: "pinned",
          profileOverride: "restricted",
        },
      },
    },
  })
  const created = []
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: {
      permission: {
        async create(input) {
          created.push(input)
          return response({ id: input.id, effect: "ask" })
        },
      },
    },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    notify: async () => {},
  })
  runtime.rememberTurn("session-1", "message-1", restrictedPolicy)
  const output = { options: {} }

  await runtime.chatParams({
    sessionID: "session-1",
    message: { id: "message-1" },
    model: { providerID: "claude-agent", id: "claude-opus-4-8" },
    agent: "claude",
  }, output)
  const pending = output.options.permissionCallback(
    "Bash",
    { command: "git status" },
    { signal: new AbortController().signal, toolUseID: "tool-1" },
  )
  while (created.length === 0) await Promise.resolve()
  await runtime.event({
    type: "permission.v2.replied",
    properties: {
      sessionID: "session-1",
      requestID: created[0].id,
      reply: "once",
    },
  })

  assert.deepEqual(await pending, { behavior: "allow" })
  assert.equal(created[0].action, "bash")
  assert.deepEqual(created[0].resources, ["git status"])
  assert.deepEqual(output.options.permissionProfile, { mode: "default", default: "ask" })

  const malformed = output.options.permissionCallback(
    "Read",
    { file_path: "README.md" },
    { signal: new AbortController().signal, toolUseID: "tool-2" },
  )
  while (created.length < 2) await Promise.resolve()
  await runtime.event({
    type: "permission.v2.replied",
    properties: {
      sessionID: "session-1",
      requestID: created[1].id,
      reply: "future-unknown-reply",
    },
  })
  assert.equal((await malformed).behavior, "deny")
})

test("turn limits block excess OpenCode steps and tool calls", async () => {
  const store = fakeSessions({ "session-1": { id: "session-1", metadata: {} } })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    notify: async () => {},
  })
  runtime.rememberTurn("session-1", "message-1", restrictedPolicy)
  const input = {
    sessionID: "session-1",
    message: { id: "message-1" },
    model: { providerID: "zai-coding-plan", id: "glm-5.2" },
    agent: "glm",
  }

  await runtime.chatParams(input, { options: {} })
  await runtime.chatParams(input, { options: {} })
  await assert.rejects(runtime.chatParams(input, { options: {} }), /max_steps 2/)
  await runtime.toolBefore({ sessionID: "session-1", tool: "read", callID: "tool-1" })
  await runtime.toolBefore({ sessionID: "session-1", tool: "read", callID: "tool-2" })
  await assert.rejects(
    runtime.toolBefore({ sessionID: "session-1", tool: "read", callID: "tool-3" }),
    /max_tool_calls 2/,
  )
})

test("turn tracking keeps only the active message for a session", async () => {
  const store = fakeSessions({ "session-1": { id: "session-1", metadata: {} } })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    notify: async () => {},
  })
  const loosePolicy = {
    ...restrictedPolicy,
    limits: { ...restrictedPolicy.limits, max_steps: 3 },
  }
  const strictPolicy = {
    ...restrictedPolicy,
    limits: { ...restrictedPolicy.limits, max_steps: 1 },
  }
  runtime.rememberTurn("session-1", "message-1", loosePolicy)
  runtime.rememberTurn("session-1", "message-2", strictPolicy)
  const staleInput = {
    sessionID: "session-1",
    message: { id: "message-1" },
    model: { providerID: "zai-coding-plan", id: "glm-5.2" },
    agent: "glm",
  }

  await runtime.chatParams(staleInput, { options: {} })
  await assert.rejects(
    runtime.chatParams(staleInput, { options: {} }),
    /max_steps 1/,
  )
})

test("turn tracking evicts inactive sessions at its fixed capacity", async () => {
  const store = fakeSessions()
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    notify: async () => {},
  })
  const fullPolicy = {
    profile: "full",
    source: "defaults",
    selector: "fallback",
    permissions: [],
    limits: {},
  }
  for (let index = 0; index <= 1024; index += 1) {
    runtime.rememberTurn(`session-${index}`, `message-${index}`, fullPolicy)
  }

  const evictedOutput = { options: {} }
  await runtime.chatParams({
    sessionID: "session-0",
    message: { id: "message-0" },
    model: { providerID: "claude-agent", id: "claude-opus-4-8" },
    agent: "claude",
  }, evictedOutput)
  assert.equal(evictedOutput.options.permissionProfile, undefined)

  const activeOutput = { options: {} }
  await runtime.chatParams({
    sessionID: "session-1024",
    message: { id: "message-1024" },
    model: { providerID: "claude-agent", id: "claude-opus-4-8" },
    agent: "claude",
  }, activeOutput)
  assert.deepEqual(activeOutput.options.permissionProfile, {
    mode: "default",
    default: "allow",
  })
})

test("pinned Claude resolves explicit OpenCode agent mentions in a child session", async () => {
  const store = fakeSessions({ "session-1": { id: "session-1", metadata: {} } })
  const calls = []
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: {
      permission: {},
      async prompt(input) {
        calls.push(["prompt", structuredClone(input)])
        return response({ id: "input-1" })
      },
      async wait(input) {
        calls.push(["wait", structuredClone(input)])
      },
      async context(input) {
        calls.push(["context", structuredClone(input)])
        return response([{
          type: "assistant",
          agent: "reviewer",
          content: [{ type: "text", text: "A revisão encontrou duas condições de corrida." }],
        }])
      },
    },
    loadPolicy: async () => ({}),
    resolvePolicy: () => ({
      ...restrictedPolicy,
      profile: "restricted",
      source: "agent",
      selector: "reviewer",
    }),
  })

  const parts = await runtime.resolveAgentMentions({
    sessionID: "session-1",
    parts: [
      { type: "text", text: "Revise a implementação." },
      { type: "agent", name: "reviewer" },
      { type: "file", mime: "text/plain", filename: "notes.txt", url: "file:///notes.txt" },
    ],
  })

  assert.equal(parts.some((part) => part.type === "agent"), false)
  assert.match(parts[1].text, /Completed result.*@reviewer.*duas condições/s)
  assert.equal(store.sessions["child-1"].parentID, "session-1")
  assert.equal(store.sessions["child-1"].agent, "reviewer")
  assert.deepEqual(calls[0][1].prompt.files, [{
    uri: "file:///notes.txt",
    name: "notes.txt",
    description: "text/plain",
  }])
  const childInput = {
    sessionID: "child-1",
    message: { id: "child-message" },
    model: { providerID: "zai-coding-plan", id: "glm-5.2" },
    agent: "reviewer",
  }
  await runtime.chatParams(childInput, { options: {} })
  await runtime.chatParams(childInput, { options: {} })
  await assert.rejects(runtime.chatParams(childInput, { options: {} }), /max_steps 2/)
})

test("agent mentions and Claude tools obey child depth and permission cancellation", async () => {
  const store = fakeSessions({
    root: { id: "root", metadata: {} },
    child: { id: "child", parentID: "root", metadata: {} },
  })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: {
      permission: {
        async create(input) {
          return response({ id: input.id, effect: "ask" })
        },
      },
      async prompt() {},
      async wait() {},
      async context() { return response([]) },
    },
    loadPolicy: async () => ({}),
    resolvePolicy: () => restrictedPolicy,
    permissionTimeoutMs: 5,
  })

  await assert.rejects(
    runtime.resolveAgentMentions({
      sessionID: "child",
      parts: [{ type: "text", text: "continue" }, { type: "agent", name: "reviewer" }],
    }),
    /max_child_depth 1/,
  )

  runtime.rememberTurn("root", "message-1", restrictedPolicy)
  const output = { options: {} }
  await runtime.chatParams({
    sessionID: "root",
    message: { id: "message-1" },
    model: { providerID: "claude-agent", id: "claude-opus-4-8" },
    agent: "claude",
  }, output)
  const denied = await output.options.permissionCallback("Read", { file_path: "README.md" }, {})
  assert.equal(denied.behavior, "deny")
  assert.match(denied.message, /timed out/)
  const nested = await output.options.permissionCallback(
    "Agent",
    { prompt: "delegate again" },
    { agentID: "subagent-1" },
  )
  assert.equal(nested.behavior, "deny")
  assert.match(nested.message, /max_child_depth 1/)
  await runtime.dispose()
})

test("forked control metadata is ignored and explicit full bypasses project restrictions", async () => {
  const store = fakeSessions({
    parent: {
      id: "parent",
      metadata: {
        [ROUTER_CONTROL_METADATA_KEY]: {
          schemaVersion: 1,
          sessionID: "parent",
          mode: "pinned",
          profileOverride: "restricted",
        },
      },
    },
    fork: {
      id: "fork",
      metadata: {
        [ROUTER_CONTROL_METADATA_KEY]: {
          schemaVersion: 1,
          sessionID: "parent",
          mode: "pinned",
          profileOverride: "restricted",
        },
      },
    },
  })
  const runtime = createRouterControlRuntime({
    directory: "/workspace",
    sessionClient: store.client,
    v2SessionClient: { permission: {} },
    loadPolicy: async () => ({}),
    resolvePolicy: (_policy, { sessionOverride }) => ({
      profile: sessionOverride ?? "restricted",
      source: "project",
      selector: "defaultProfile",
      permissions: [{ permission: "*", pattern: "*", action: "deny" }],
      limits: { max_steps: 1 },
    }),
  })

  assert.equal(await runtime.routingAgent("fork", "router"), "router-adaptive")
  const output = { parts: [] }
  await runtime.commandBefore({ command: "router-full", sessionID: "fork", arguments: "" }, output)
  assert.deepEqual(store.sessions.fork.permission, [
    { permission: "*", pattern: "*", action: "allow" },
  ])
  const effective = await runtime.resolveFor({ sessionID: "fork", agent: "glm" })
  assert.deepEqual(effective.policy.limits, {})
})
