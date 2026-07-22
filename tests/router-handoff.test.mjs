import assert from "node:assert/strict"
import test from "node:test"

import {
  createDirectModelHandoff,
  persistDirectModelSelection,
} from "../opencode/lib/direct_handoff.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../opencode/lib/opencode_transport.mjs"

function userMessage(text, agent = "router") {
  return {
    input: {
      sessionID: "session-1",
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

test("reuses the legacy client's in-process fetch for v2 session persistence", async () => {
  const requests = []
  const inProcessFetch = async (request) => {
    requests.push({
      url: request.url,
      method: request.method,
      body: await request.clone().json(),
    })
    return new Response(null, { status: 204 })
  }
  const legacyClient = {
    _client: {
      getConfig() {
        return {
          baseUrl: "http://localhost:4096",
          headers: { authorization: "test-only" },
          fetch: inProcessFetch,
        }
      },
    },
  }
  let v2Config
  const createV2Client = (config) => {
    v2Config = config
    return {
      v2: {
        session: {
          switchAgent({ sessionID, agent }) {
            return config.fetch(new Request(`${config.baseUrl}/api/session/${sessionID}/agent`, {
              method: "POST",
              headers: config.headers,
              body: JSON.stringify({ agent }),
            }))
          },
          switchModel({ sessionID, model }) {
            return config.fetch(new Request(`${config.baseUrl}/api/session/${sessionID}/model`, {
              method: "POST",
              headers: config.headers,
              body: JSON.stringify({ model }),
            }))
          },
        },
      },
    }
  }
  const client = createOpenCodeV2ClientFromLegacyTransport({
    legacyClient,
    createV2Client,
    directory: "/repo",
  })

  assert.equal(v2Config.baseUrl, "http://localhost:4096")
  assert.deepEqual(v2Config.headers, { authorization: "test-only" })
  assert.equal(v2Config.fetch, inProcessFetch)
  assert.equal(v2Config.directory, "/repo")

  await persistDirectModelSelection(
    client,
    "session-1",
    { agent: "claude", providerID: "claude-agent", modelID: "claude-opus-4-8" },
    { agent: "router", providerID: "ollama", modelID: "router-model" },
  )

  assert.deepEqual(requests, [
    {
      url: "http://localhost:4096/api/session/session-1/agent",
      method: "POST",
      body: { agent: "claude" },
    },
    {
      url: "http://localhost:4096/api/session/session-1/model",
      method: "POST",
      body: { model: { providerID: "claude-agent", id: "claude-opus-4-8" } },
    },
  ])
})

test("fails explicitly when the OpenCode 1.18.4 legacy transport shape drifts", () => {
  const createV2Client = () => {
    throw new Error("factory must not run")
  }

  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: {},
      createV2Client,
      directory: "/repo",
    }),
    /legacy client transport is unavailable/,
  )
  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: { _client: { getConfig: () => ({ baseUrl: "", fetch() {} }) } },
      createV2Client,
      directory: "/repo",
    }),
    /legacy client transport has no baseUrl/,
  )
  assert.throws(
    () => createOpenCodeV2ClientFromLegacyTransport({
      legacyClient: { _client: { getConfig: () => ({ baseUrl: "http:\/\/localhost:4096" }) } },
      createV2Client,
      directory: "/repo",
    }),
    /legacy client transport has no fetch function/,
  )
})

for (const [route, agent, providerID, modelID] of destinations) {
  test(`hands the current user message directly to ${route}`, async () => {
    const hooks = createDirectModelHandoff({ classify: classifier(route) })
    const message = userMessage("pedido original")

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, agent)
    assert.deepEqual(message.output.message.model, { providerID, modelID })
  })
}

test("persists the selected agent and model through the OpenCode v2 client", async () => {
  const calls = []
  const client = {
    v2: {
      session: {
        async switchAgent(...args) {
          calls.push(["agent", ...args])
        },
        async switchModel(...args) {
          calls.push(["model", ...args])
        },
      },
    },
  }
  const target = {
    agent: "claude",
    providerID: "claude-agent",
    modelID: "claude-opus-4-8",
  }

  await persistDirectModelSelection(client, "session-1", target, {
    agent: "router",
    providerID: "ollama",
    modelID: "router-model",
  })

  assert.deepEqual(calls, [
    ["agent", { sessionID: "session-1", agent: "claude" }, { throwOnError: true }],
    [
      "model",
      {
        sessionID: "session-1",
        model: { providerID: "claude-agent", id: "claude-opus-4-8" },
      },
      { throwOnError: true },
    ],
  ])
})

test("persists before mutating the current turn and fails closed", async () => {
  let announced = false
  let message
  const hooks = createDirectModelHandoff({
    classify: classifier("claude"),
    persist: async ({ previous }) => {
      assert.deepEqual(previous, {
        agent: "router",
        providerID: "ollama",
        modelID: "hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M",
      })
      assert.equal(message.output.message.agent, "router")
      throw new Error("switch failed")
    },
    announce: async () => { announced = true },
  })
  message = userMessage("pedido")

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /switch failed/,
  )
  assert.deepEqual(message.output.message.model, {
    providerID: "ollama",
    modelID: "hf.co/mradermacher/Plano-Orchestrator-4B-GGUF:Q4_K_M",
  })
  assert.equal(message.output.message.agent, "router")
  assert.equal(announced, false)
})

test("rolls the agent back when model persistence fails", async () => {
  const calls = []
  const modelError = new Error("model switch failed")
  const client = {
    v2: {
      session: {
        async switchAgent(...args) {
          calls.push(["agent", ...args])
        },
        async switchModel(...args) {
          calls.push(["model", ...args])
          throw modelError
        },
      },
    },
  }

  await assert.rejects(
    persistDirectModelSelection(
      client,
      "session-1",
      { agent: "claude", providerID: "claude-agent", modelID: "claude-opus-4-8" },
      { agent: "router", providerID: "ollama", modelID: "router-model" },
    ),
    (error) => error === modelError,
  )
  assert.deepEqual(calls.map(([kind, parameters]) => [kind, parameters]), [
    ["agent", { sessionID: "session-1", agent: "claude" }],
    ["model", { sessionID: "session-1", model: { providerID: "claude-agent", id: "claude-opus-4-8" } }],
    ["agent", { sessionID: "session-1", agent: "router" }],
  ])
})

test("preserves model and rollback failures in an AggregateError", async () => {
  const modelError = new Error("model switch failed")
  const rollbackError = new Error("agent rollback failed")
  let agentCalls = 0
  const client = {
    v2: {
      session: {
        async switchAgent() {
          agentCalls += 1
          if (agentCalls === 2) throw rollbackError
        },
        async switchModel() {
          throw modelError
        },
      },
    },
  }

  await assert.rejects(
    persistDirectModelSelection(
      client,
      "session-1",
      { agent: "claude", providerID: "claude-agent", modelID: "claude-opus-4-8" },
      { agent: "router", providerID: "ollama", modelID: "router-model" },
    ),
    (error) => error instanceof AggregateError
      && error.errors[0] === modelError
      && error.errors[1] === rollbackError,
  )
})

test("keeps the toast non-blocking after persistence succeeds", async () => {
  let persisted = false
  const hooks = createDirectModelHandoff({
    classify: classifier("glm"),
    persist: async () => { persisted = true },
    announce: async () => { throw new Error("TUI unavailable") },
  })
  const message = userMessage("pedido")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(persisted, true)
  assert.equal(message.output.message.agent, "glm")
})

test("classifies the exact non-synthetic user text once", async () => {
  const received = []
  const hooks = createDirectModelHandoff({
    classify: async (request) => {
      received.push(request)
      return {
        stdout: JSON.stringify({ schema_version: 1, intent: "literal", route: "minimax" }),
      }
    },
  })
  const message = userMessage("linha 1\nlinha 2 com \"aspas\"")
  message.output.parts.push({ type: "text", text: "texto sintético", synthetic: true })

  await hooks["chat.message"](message.input, message.output)

  assert.deepEqual(received, ["linha 1\nlinha 2 com \"aspas\""])
})

test("promotes a mutating request away from MiniMax before handoff", async () => {
  const hooks = createDirectModelHandoff({ classify: classifier("minimax") })
  const message = userMessage("corrija o arquivo de configuração")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "glm")
  assert.deepEqual(message.output.message.model, {
    providerID: "zai-coding-plan",
    modelID: "glm-5.2",
  })
})

test("reclassifies the next message when the UI kept the previous managed agent", async () => {
  let calls = 0
  const hooks = createDirectModelHandoff({
    classify: async () => {
      calls += 1
      return classifier("claude")()
    },
  })
  const message = userMessage("pedido", "glm")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(calls, 1)
  assert.equal(message.output.message.agent, "claude")
  assert.equal(message.output.message.model.providerID, "claude-agent")
})

test("does not reroute unrelated custom agents", async () => {
  let calls = 0
  const hooks = createDirectModelHandoff({
    classify: async () => {
      calls += 1
      return classifier("codex")()
    },
  })
  const message = userMessage("pedido", "custom-agent")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(calls, 0)
  assert.equal(message.output.message.agent, "custom-agent")
})

test("fails closed without changing the selected agent on invalid classifier output", async () => {
  const hooks = createDirectModelHandoff({
    classify: async () => ({ stdout: "not-json" }),
  })
  const message = userMessage("pedido")
  const original = structuredClone(message.output.message)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /invalid JSON/,
  )
  assert.deepEqual(message.output.message, original)
})

test("fails closed when the router process reports an execution error", async () => {
  const hooks = createDirectModelHandoff({
    classify: async () => {
      throw new Error("llm-router failed with exit 1")
    },
  })
  const message = userMessage("pedido")

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /failed with exit 1/,
  )
  assert.equal(message.output.message.agent, "router")
})

test("ignores empty messages without invoking the classifier", async () => {
  let calls = 0
  const hooks = createDirectModelHandoff({
    classify: async () => {
      calls += 1
      return classifier("glm")()
    },
  })
  const message = userMessage("")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(calls, 0)
  assert.equal(message.output.message.agent, "router")
})
