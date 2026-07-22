import assert from "node:assert/strict"
import test from "node:test"

import {
  createDirectModelHandoff,
  MANUAL_TARGET_METADATA_KEY,
} from "../opencode/lib/direct_handoff.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../opencode/lib/opencode_transport.mjs"

function userMessage(text, agent = "router-auto", sessionID = "session-1") {
  return {
    input: {
      sessionID,
      agent,
      model: {
        providerID: "ollama",
        modelID: "hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M",
      },
    },
    output: {
      message: {
        agent,
        model: {
          providerID: "ollama",
          modelID: "hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M",
        },
      },
      parts: [{ type: "text", text }],
    },
  }
}

function classifier(route, intent = "test_intent") {
  return async (request) => ({
    request,
    stdout: JSON.stringify({ schema_version: 1, intent, route }),
  })
}

const destinations = [
  ["minimax", "minimax", "minimax-coding-plan", "MiniMax-M3"],
  ["glm", "glm", "zai-coding-plan", "glm-5.2"],
  ["claude", "claude", "claude-agent", "claude-opus-4-8"],
  ["codex", "codex", "openai", "gpt-5.6-sol"],
]

test("reuses the legacy in-process transport for the v2 metadata client", () => {
  const inProcessFetch = async () => new Response(null, { status: 204 })
  const expectedClient = { session: {} }
  let received

  const client = createOpenCodeV2ClientFromLegacyTransport({
    legacyClient: {
      _client: {
        getConfig: () => ({
          baseUrl: "http://opencode.internal",
          headers: { authorization: "test-only" },
          fetch: inProcessFetch,
        }),
      },
    },
    createV2Client: (config) => {
      received = config
      return expectedClient
    },
    directory: "/workspace",
  })

  assert.equal(client, expectedClient)
  assert.deepEqual(received, {
    baseUrl: "http://opencode.internal",
    headers: { authorization: "test-only" },
    fetch: inProcessFetch,
    directory: "/workspace",
  })
})

test("fails explicitly when the legacy in-process transport shape changes", () => {
  const createV2Client = () => {
    throw new Error("factory must not run")
  }

  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: {},
      createV2Client,
      directory: "/workspace",
    }),
    /legacy client transport is unavailable/,
  )
  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: { _client: { getConfig: () => ({ baseUrl: "", fetch() {} }) } },
      createV2Client,
      directory: "/workspace",
    }),
    /legacy client transport has no baseUrl/,
  )
  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: { _client: { getConfig: () => ({ baseUrl: "http://opencode.internal" }) } },
      createV2Client,
      directory: "/workspace",
    }),
    /legacy client transport has no fetch function/,
  )
})

for (const [route, agent, providerID, modelID] of destinations) {
  test(`auto hands the current user message directly to ${route}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier(route), client: store.client })
    const message = userMessage("pedido original")

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, agent)
    assert.deepEqual(message.output.message.model, { providerID, modelID })
  })
}

test("auto reclassifies every message without changing session selection", async () => {
  const requests = []
  const announcements = []
  const routes = ["glm", "claude"]
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: async (request) => {
      requests.push(request)
      return classifier(routes[requests.length - 1])()
    },
    client: store.client,
    announce: async (event) => { announcements.push(event) },
  })
  const first = userMessage("primeiro")
  const second = userMessage("segundo")

  await hooks["chat.message"](first.input, first.output)
  await hooks["chat.message"](second.input, second.output)

  assert.deepEqual(requests, ["primeiro", "segundo"])
  assert.equal(first.input.agent, "router-auto")
  assert.equal(second.input.agent, "router-auto")
  assert.equal(first.output.message.agent, "glm")
  assert.equal(second.output.message.agent, "claude")
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get"])
  assert.deepEqual(
    announcements.map(({ mode, reused, route }) => ({ mode, reused, route })),
    [
      { mode: "auto", reused: false, route: "glm" },
      { mode: "auto", reused: false, route: "claude" },
    ],
  )
})

function memorySessionClient(initialSessions) {
  const sessions = structuredClone(initialSessions)
  const calls = []
  return {
    calls,
    sessions,
    client: {
      session: {
        async get(parameters, options) {
          calls.push(["get", structuredClone(parameters), structuredClone(options)])
          return { data: structuredClone(sessions[parameters.sessionID]) }
        },
        async update(parameters, options) {
          calls.push(["update", structuredClone(parameters), structuredClone(options)])
          sessions[parameters.sessionID] = {
            ...sessions[parameters.sessionID],
            metadata: structuredClone(parameters.metadata),
          }
          return { data: structuredClone(sessions[parameters.sessionID]) }
        },
      },
      v2: {
        session: {
          async switchAgent(parameters, options) {
            calls.push(["switch-agent", structuredClone(parameters), structuredClone(options)])
            sessions[parameters.sessionID] = {
              ...sessions[parameters.sessionID],
              agent: parameters.agent,
            }
          },
        },
      },
    },
  }
}

test("manual persists the first target and reuses it for the session", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-manual", metadata: {} } })
  const requests = []
  const announcements = []
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async (request) => {
      requests.push(request)
      return classifier("claude")()
    },
    announce: async (event) => { announcements.push(event) },
  })
  const first = userMessage("primeiro", "router-manual")
  const second = userMessage("segundo", "router-manual")

  await hooks["chat.message"](first.input, first.output)
  await hooks["chat.message"](second.input, second.output)

  assert.deepEqual(requests, ["primeiro"])
  assert.equal(first.input.agent, "router-manual")
  assert.equal(second.input.agent, "router-manual")
  assert.equal(first.output.message.agent, "claude")
  assert.equal(second.output.message.agent, "claude")
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "update", "get"])
  assert.deepEqual(store.sessions["session-1"].metadata[MANUAL_TARGET_METADATA_KEY], {
    sessionID: "session-1",
    target: {
      agent: "claude",
      providerID: "claude-agent",
      modelID: "claude-opus-4-8",
    },
  })
  assert.deepEqual(
    announcements.map(({ mode, reused, route }) => ({ mode, reused, route })),
    [
      { mode: "manual", reused: false, route: "claude" },
      { mode: "manual", reused: true, route: "claude" },
    ],
  )
})

test("manual classifies a new session independently", async () => {
  const store = memorySessionClient({
    "session-1": { agent: "router-manual", metadata: {} },
    "session-2": { agent: "router-manual", metadata: {} },
  })
  const routes = ["glm", "codex"]
  let calls = 0
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => classifier(routes[calls++])(),
  })
  const first = userMessage("primeiro", "router-manual", "session-1")
  const second = userMessage("segundo", "router-manual", "session-2")

  await hooks["chat.message"](first.input, first.output)
  await hooks["chat.message"](second.input, second.output)

  assert.equal(calls, 2)
  assert.equal(first.output.message.agent, "glm")
  assert.equal(second.output.message.agent, "codex")
})

test("manual target stays fixed when a resumed client presents router-auto", async () => {
  const store = memorySessionClient({
    "session-1": {
      agent: "router-auto",
      metadata: {
        [MANUAL_TARGET_METADATA_KEY]: {
          sessionID: "session-1",
          target: {
            agent: "glm",
            providerID: "zai-coding-plan",
            modelID: "glm-5.2",
          },
        },
      },
    },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("sticky manual routing must not classify again")
    },
  })
  const message = userMessage("planeje uma arquitetura", "router-auto")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "glm")
  assert.equal(store.sessions["session-1"].agent, "router-manual")
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "switch-agent"])
  assert.deepEqual(store.calls[1], [
    "switch-agent",
    { sessionID: "session-1", agent: "router-manual" },
    { throwOnError: true },
  ])
})

test("manual target inherited by a fork is classified for the new session", async () => {
  const inherited = {
    [MANUAL_TARGET_METADATA_KEY]: {
      sessionID: "session-1",
      target: {
        agent: "claude",
        providerID: "claude-agent",
        modelID: "claude-opus-4-8",
      },
    },
  }
  const store = memorySessionClient({
    "session-2": { agent: "router-manual", metadata: inherited },
  })
  let classifications = 0
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => {
      classifications += 1
      return classifier("codex")()
    },
  })
  const message = userMessage("novo pedido", "router-manual", "session-2")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(classifications, 1)
  assert.equal(message.output.message.agent, "codex")
  assert.equal(
    store.sessions["session-2"].metadata[MANUAL_TARGET_METADATA_KEY].sessionID,
    "session-2",
  )
})

test("manual merges its namespaced target with existing session metadata", async () => {
  const store = memorySessionClient({
    "session-1": {
      agent: "router-manual",
      metadata: {
        "other.plugin.key": { enabled: true },
        owner: "user",
      },
    },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: classifier("glm"),
  })
  const message = userMessage("pedido", "router-manual")

  await hooks["chat.message"](message.input, message.output)

  assert.deepEqual(store.sessions["session-1"].metadata, {
    "other.plugin.key": { enabled: true },
    owner: "user",
    [MANUAL_TARGET_METADATA_KEY]: {
      sessionID: "session-1",
      target: {
        agent: "glm",
        providerID: "zai-coding-plan",
        modelID: "glm-5.2",
      },
    },
  })
  assert.deepEqual(store.calls[1], [
    "update",
    {
      sessionID: "session-1",
      metadata: store.sessions["session-1"].metadata,
    },
    { throwOnError: true },
  ])
})

test("manual fails closed when target persistence fails", async () => {
  let announced = false
  const hooks = createDirectModelHandoff({
    classify: classifier("claude"),
    client: {
      session: {
        async get() { return { data: { agent: "router-manual", metadata: { owner: "user" } } } },
        async update() { throw new Error("metadata update failed") },
      },
      v2: { session: { async switchAgent() { throw new Error("switch must not run") } } },
    },
    announce: async () => { announced = true },
  })
  const message = userMessage("pedido", "router-manual")
  const original = structuredClone(message.output.message)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /metadata update failed/,
  )

  assert.deepEqual(message.output.message, original)
  assert.equal(announced, false)
})

test("manual fails closed when session persistence cannot be read", async () => {
  const hooks = createDirectModelHandoff({
    classify: () => {
      throw new Error("classifier must not run")
    },
    client: {
      session: {
        async get() { throw new Error("metadata read failed") },
        async update() { throw new Error("update must not run") },
      },
    },
  })
  const message = userMessage("pedido", "router-manual")
  const original = structuredClone(message.output.message)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /metadata read failed/,
  )

  assert.deepEqual(message.output.message, original)
})

test("auto classification failures leave the router sentinel selected", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: async () => ({ stdout: "not-json" }),
    client: store.client,
  })
  const message = userMessage("pedido")
  const original = structuredClone(message.output.message)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /invalid JSON/,
  )
  assert.deepEqual(message.output.message, original)
})

test("manual classification failures leave the router sentinel selected", async () => {
  const hooks = createDirectModelHandoff({
    classify: async () => ({ stdout: "not-json" }),
    client: {
      session: {
        async get() { return { data: { agent: "router-manual", metadata: {} } } },
        async update() { throw new Error("update must not run") },
      },
      v2: { session: { async switchAgent() { throw new Error("switch must not run") } } },
    },
  })
  const message = userMessage("pedido", "router-manual")
  const original = structuredClone(message.output.message)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /invalid JSON/,
  )
  assert.deepEqual(message.output.message, original)
})

test("classifies the exact non-synthetic user text once", async () => {
  const received = []
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: async (request) => {
      received.push(request)
      return {
        stdout: JSON.stringify({ schema_version: 1, intent: "literal", route: "minimax" }),
      }
    },
    client: store.client,
  })
  const message = userMessage("linha 1\nlinha 2 com \"aspas\"")
  message.output.parts.push({ type: "text", text: "texto sintético", synthetic: true })

  await hooks["chat.message"](message.input, message.output)

  assert.deepEqual(received, ["linha 1\nlinha 2 com \"aspas\""])
})

test("promotes a mutating request away from MiniMax before handoff", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("minimax"), client: store.client })
  const message = userMessage("corrija o arquivo de configuração")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "glm")
  assert.deepEqual(message.output.message.model, {
    providerID: "zai-coding-plan",
    modelID: "glm-5.2",
  })
})

test("ignores agents outside router-auto and router-manual", async () => {
  let calls = 0
  const hooks = createDirectModelHandoff({
    classify: async () => {
      calls += 1
      return classifier("glm")()
    },
  })
  const message = userMessage("pedido", "custom-agent")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(calls, 0)
  assert.equal(message.output.message.agent, "custom-agent")
})

test("keeps the toast non-blocking after a selection succeeds", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: classifier("glm"),
    client: store.client,
    announce: async () => { throw new Error("TUI unavailable") },
  })
  const message = userMessage("pedido")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "glm")
})
