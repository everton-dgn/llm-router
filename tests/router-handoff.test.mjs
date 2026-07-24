import assert from "node:assert/strict"
import test from "node:test"

import {
  createDirectModelHandoff,
  MANUAL_TARGET_METADATA_KEY,
} from "../opencode/lib/direct_handoff.mjs"
import { ROUTING_STATE_METADATA_KEY } from "../opencode/lib/adaptive_routing.mjs"
import { CLAUDE_CHECKPOINT_METADATA_KEY } from "../opencode/lib/claude_checkpoint.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../opencode/lib/opencode_transport.mjs"
import {
  LITERAL_READ_ONLY_INTENT,
  enforceMinimumRoute,
  routeCapabilities,
} from "../opencode/lib/routing_policy.mjs"
import { updateSessionMetadata } from "../opencode/lib/session_metadata.mjs"

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

function routingState({
  sessionID = "session-1",
  mode,
  currentRoute,
  turnsOnCurrent = 1,
  cooldownTurnsRemaining = 0,
  ...extra
}) {
  return {
    schemaVersion: 1,
    sessionID,
    mode,
    currentRoute,
    turnsOnCurrent,
    cooldownTurnsRemaining,
    ...extra,
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

test("declares deterministic capabilities for every route", () => {
  assert.deepEqual(routeCapabilities, {
    minimax: {
      canExecuteCommands: false,
      canHandleNonLiteralText: false,
      canMutateProject: false,
      canReadRepository: true,
      canUseAgentMentions: false,
      canUseAttachments: false,
      canUseExternalTools: false,
    },
    glm: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true,
    },
    claude: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true,
    },
    codex: {
      canExecuteCommands: true,
      canHandleNonLiteralText: true,
      canMutateProject: true,
      canReadRepository: true,
      canUseAgentMentions: true,
      canUseAttachments: true,
      canUseExternalTools: true,
    },
  })
})

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
    const message = userMessage(route === "minimax" ? "liste os arquivos" : "pedido original")

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, agent)
    assert.deepEqual(message.output.message.model, { providerID, modelID })
  })
}

test("auto reclassifies every message and persists its latest route", async () => {
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
  assert.deepEqual(
    store.calls.map(([method]) => method),
    ["get", "get", "update", "get", "get", "update"],
  )
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "auto", currentRoute: "claude" }),
  )
  assert.deepEqual(
    announcements.map(({ mode, reused, route }) => ({ mode, reused, route })),
    [
      { mode: "auto", reused: false, route: "glm" },
      { mode: "auto", reused: false, route: "claude" },
    ],
  )
})

test("auto keeps a mutating request on capable Claude", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("corrija o arquivo de configuração")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(message.output.message.model, {
    providerID: "claude-agent",
    modelID: "claude-opus-4-8",
  })
})

test("auto preserves Claude for a negated mutation", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("não altere o arquivo, apenas explique o problema")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(message.output.message.model, {
    providerID: "claude-agent",
    modelID: "claude-opus-4-8",
  })
})

test("auto preserves Claude when every coordinated mutation is negated", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("não altere nem remova arquivos, apenas explique o problema")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto treats mutation words in an explanation as quoted concepts", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("explique a diferença entre update e replace")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

for (const request of [
  "explain how to update and replace the config",
  "compare create and update operations",
  "explain whether to create or modify",
  "o que faz a função update?",
  "what does replace do?",
]) {
  test(`auto preserves Claude for the conceptual request: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

for (const request of [
  "create three product ideas",
  "write sales copy",
  "faça um plano",
  "cria uma estratégia",
  "add another idea",
  "create a migration plan",
  "create a plan to fix the race condition",
  "write an ADR for this API",
  "crie uma estratégia de testes",
  "analyze project strategy",
]) {
  test(`auto does not treat text creation as a project mutation: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

test("auto keeps a real mutation mixed with an explanation on Claude", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage(
    "explique a diferença entre update e replace e atualize o README",
  )

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

for (const request of [
  "explain the problem and fix the file",
  "explain or fix the file",
]) {
  test(`auto keeps the real English mutation on Claude in: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

for (const request of ["faz logo tudo", "cria o arquivo de configuração"]) {
  test(`auto keeps an informal PT-BR mutation on Claude in: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

test("auto preserves informal PT-BR mutations when all are negated", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("não faz nem cria arquivos")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto keeps explicit repository inspection on capable Claude", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("inspecione o repositório e informe a versão do React")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

for (const request of [
  "analise este repositório",
  "inspeciona o repositório",
  "busca no repo a configuração",
  "procura no projeto a função principal",
  "verifica o package.json",
]) {
  test(`auto keeps informal repository inspection on Claude in: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

test("auto keeps explicit web research on capable Claude", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("pesquise na web a previsão do tempo atual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto recognizes informal web research", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("pesquisa na internet a previsão atual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto keeps explicit command execution on capable Claude", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage("rode os testes deste projeto")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

for (const request of ["ls", "pwd", "rode ls"]) {
  test(`auto keeps a standalone command on Claude in: ${request}`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
    const message = userMessage(request)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
  })
}

test("auto ignores fully negated command, repository, and web capabilities", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage(
    "não rode comandos, nem leia o repositório, nem pesquise na web; apenas explique a abordagem",
  )

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto keeps a Claude attachment without adding it to the classifier prompt", async () => {
  const received = []
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: async (request) => {
      received.push(request)
      return classifier("claude")()
    },
    client: store.client,
  })
  const message = userMessage("analise o anexo")
  message.output.parts.push({
    type: "file",
    filename: "report.txt",
    mime: "text/plain",
    url: "data:text/plain,conteudo-privado",
  })

  await hooks["chat.message"](message.input, message.output)

  assert.deepEqual(received, ["analise o anexo"])
  assert.equal(message.output.message.agent, "claude")
})

test("auto routes a file-only message without invoking the classifier", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: () => {
      throw new Error("file-only routing must not invoke the classifier")
    },
    client: store.client,
  })
  const message = userMessage("")
  message.output.parts.push({
    type: "file",
    filename: "private-report.txt",
    mime: "text/plain",
    url: "data:text/plain,private-content",
  })

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto keeps a Claude agent mention without adding it to the classifier prompt", async () => {
  const received = []
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: async (request) => {
      received.push(request)
      return classifier("claude")()
    },
    client: store.client,
  })
  const message = userMessage("revise esta proposta")
  message.output.parts.push({ type: "agent", name: "private-reviewer" })

  await hooks["chat.message"](message.input, message.output)

  assert.deepEqual(received, ["revise esta proposta"])
  assert.equal(message.output.message.agent, "claude")
})

test("auto routes an agent-only message without invoking the classifier", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({
    classify: () => {
      throw new Error("agent-only routing must not invoke the classifier")
    },
    client: store.client,
  })
  const message = userMessage("")
  message.output.parts.push({ type: "agent", name: "private-reviewer" })

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

test("auto preserves explanatory mentions of repository and web operations", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
  const hooks = createDirectModelHandoff({ classify: classifier("claude"), client: store.client })
  const message = userMessage(
    "explique a diferença entre inspect repository e search the web",
  )

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
})

for (const [label, text, extraPart] of [
  ["web research", "pesquise na web a previsão do tempo atual"],
  ["attachments", "analise o anexo", { type: "file", filename: "report.txt" }],
  ["command execution", "rode os testes deste projeto"],
  ["non-literal analysis", "explique o fluxo deste módulo"],
  ["creative text", "create three product ideas"],
  ["pros and cons", "dê prós e contras"],
  ["product naming", "crie nomes para o produto"],
  ["literal-looking English product naming", "list five product names"],
  ["literal-looking Portuguese product naming", "liste cinco nomes para o produto"],
  ["text correction", "corrija este texto"],
]) {
  test(`auto promotes MiniMax for ${label} to GLM`, async () => {
    const store = memorySessionClient({ "session-1": { agent: "router-auto", metadata: {} } })
    const hooks = createDirectModelHandoff({ classify: classifier("minimax"), client: store.client })
    const message = userMessage(text)
    if (extraPart) message.output.parts.push(extraPart)

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "glm")
  })
}

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

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

test("serializes manual target and Claude checkpoint metadata updates per session", async () => {
  const classifierEntered = deferred()
  const releaseClassifier = deferred()
  const checkpointWriteEntered = deferred()
  const releaseCheckpointWrite = deferred()
  const store = memorySessionClient({
    "session-1": {
      agent: "router-manual",
      metadata: { "other.plugin.key": { enabled: true } },
    },
  })
  const update = store.client.session.update
  store.client.session.update = async (parameters, options) => {
    if (
      parameters.metadata[CLAUDE_CHECKPOINT_METADATA_KEY]
      && !parameters.metadata[MANUAL_TARGET_METADATA_KEY]
    ) {
      checkpointWriteEntered.resolve()
      await releaseCheckpointWrite.promise
    }
    return update(parameters, options)
  }
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => {
      classifierEntered.resolve()
      await releaseClassifier.promise
      return classifier("glm")()
    },
  })
  const message = userMessage("pedido", "router-manual")

  const manualUpdate = hooks["chat.message"](message.input, message.output)
  await classifierEntered.promise
  const checkpointUpdate = updateSessionMetadata({
    sessionID: "session-1",
    readMetadata: async (sessionID) => store.sessions[sessionID].metadata,
    writeMetadata: async (sessionID, metadata) => {
      await store.client.session.update(
        { sessionID, metadata },
        { throwOnError: true },
      )
    },
    update: (metadata) => ({
      ...metadata,
      [CLAUDE_CHECKPOINT_METADATA_KEY]: {
        sessionID: "session-1",
        status: "pending",
      },
    }),
  })
  await checkpointWriteEntered.promise
  releaseClassifier.resolve()
  await Promise.resolve()
  releaseCheckpointWrite.resolve()

  await Promise.all([manualUpdate, checkpointUpdate])

  assert.deepEqual(store.sessions["session-1"].metadata, {
    "other.plugin.key": { enabled: true },
    [CLAUDE_CHECKPOINT_METADATA_KEY]: {
      sessionID: "session-1",
      status: "pending",
    },
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "glm",
    }),
  })
})

test("adaptive persists its canonical mode and switches immediately on an upgrade", async () => {
  const routes = ["glm", "codex"]
  const store = memorySessionClient({
    "session-1": { agent: "router-adaptive", metadata: { owner: "user" } },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => classifier(routes.shift())(),
  })
  const first = userMessage("implemente a correção", "router-adaptive")
  const followUp = userMessage("e isso?", "router-adaptive")

  await hooks["chat.message"](first.input, first.output)
  await hooks["chat.message"](followUp.input, followUp.output)

  assert.equal(first.output.message.agent, "glm")
  assert.equal(followUp.output.message.agent, "codex")
  assert.deepEqual(store.sessions["session-1"].metadata.owner, "user")
  assert.deepEqual(store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY], {
    schemaVersion: 1,
    sessionID: "session-1",
    mode: "adaptive",
    currentRoute: "codex",
    turnsOnCurrent: 1,
    cooldownTurnsRemaining: 1,
  })
})

test("adaptive retains short follow-ups and requires two confirmed downgrades", async () => {
  const routes = ["codex", "glm", "glm", "glm"]
  const store = memorySessionClient({
    "session-1": { agent: "router-adaptive", metadata: {} },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => classifier(routes.shift())(),
  })
  const messages = [
    userMessage("implemente a arquitetura completa", "router-adaptive"),
    userMessage("e agora?", "router-adaptive"),
    userMessage("descreva com detalhes a documentação final desta mudança", "router-adaptive"),
    userMessage("prepare também uma explicação completa para a equipe", "router-adaptive"),
  ]

  for (const message of messages) {
    await hooks["chat.message"](message.input, message.output)
  }

  assert.deepEqual(messages.map((message) => message.output.message.agent), [
    "codex",
    "codex",
    "codex",
    "glm",
  ])
  assert.equal(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY].currentRoute,
    "glm",
  )
})

test("adaptive clears a pending downgrade when the recommendation matches the current route", async () => {
  const routes = ["codex", "glm", "codex", "glm", "glm"]
  const store = memorySessionClient({
    "session-1": { agent: "router-adaptive", metadata: {} },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => classifier(routes.shift())(),
  })
  const requests = [
    "implemente a arquitetura completa",
    "descreva detalhadamente a documentação desta arquitetura",
    "continue implementando todos os arquivos necessários",
    "prepare uma explicação detalhada para toda a equipe",
    "escreva também a documentação completa desta mudança",
  ]
  const selected = []

  for (const request of requests) {
    const message = userMessage(request, "router-adaptive")
    await hooks["chat.message"](message.input, message.output)
    selected.push(message.output.message.agent)
  }

  assert.deepEqual(selected, ["codex", "codex", "codex", "codex", "glm"])
})

test("adaptive thresholds can be overridden without changing the default policy", async () => {
  const routes = ["codex", "glm", "glm", "glm"]
  const store = memorySessionClient({
    "session-1": { agent: "router-adaptive", metadata: {} },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: async () => classifier(routes.shift())(),
    adaptivePolicy: {
      minimumTurnsBeforeSwitch: 3,
      downgradeConfirmations: 2,
      switchCooldownTurns: 2,
    },
  })
  const selected = []

  for (const request of [
    "implemente a arquitetura completa",
    "descreva detalhadamente toda a documentação",
    "prepare uma explicação detalhada para a equipe",
    "escreva a documentação completa desta mudança",
  ]) {
    const message = userMessage(request, "router-adaptive")
    await hooks["chat.message"](message.input, message.output)
    selected.push(message.output.message.agent)
  }

  assert.deepEqual(selected, ["codex", "codex", "codex", "glm"])
})

test("logical router migrates a legacy manual target to pinned mode without capability checks", async () => {
  const store = memorySessionClient({
    "session-1": {
      agent: "router",
      metadata: {
        [MANUAL_TARGET_METADATA_KEY]: {
          sessionID: "session-1",
          target: {
            agent: "minimax",
            providerID: "minimax-coding-plan",
            modelID: "MiniMax-M3",
          },
        },
      },
    },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a legacy pinned target must not classify again")
    },
  })
  const message = userMessage("compare detalhadamente as alternativas", "router")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "minimax")
  assert.deepEqual(store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY], {
    schemaVersion: 1,
    sessionID: "session-1",
    mode: "pinned",
    currentRoute: "minimax",
    turnsOnCurrent: 1,
    cooldownTurnsRemaining: 0,
  })
})

test("logical router reads adaptive mode from its owned session state", async () => {
  const store = memorySessionClient({
    "session-1": {
      agent: "router",
      metadata: {
        [ROUTING_STATE_METADATA_KEY]: routingState({
          mode: "adaptive",
          currentRoute: "codex",
          turnsOnCurrent: 2,
        }),
      },
    },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: classifier("glm"),
  })
  const message = userMessage(
    "prepare uma explicação detalhada para toda a equipe",
    "router",
  )

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "codex")
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({
      mode: "adaptive",
      currentRoute: "codex",
      turnsOnCurrent: 3,
      pendingDowngrade: { route: "glm", confirmations: 1 },
    }),
  )
})

test("logical router ignores adaptive state inherited from another session", async () => {
  const store = memorySessionClient({
    "session-2": {
      agent: "router",
      metadata: {
        [ROUTING_STATE_METADATA_KEY]: routingState({
          sessionID: "session-1",
          mode: "adaptive",
          currentRoute: "codex",
          turnsOnCurrent: 4,
        }),
      },
    },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: classifier("glm"),
  })
  const message = userMessage("novo pedido", "router", "session-2")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "glm")
  assert.deepEqual(
    store.sessions["session-2"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({
      sessionID: "session-2",
      mode: "adaptive",
      currentRoute: "glm",
      cooldownTurnsRemaining: 1,
    }),
  )
})

test("pinned persists the first target and reuses it for the session", async () => {
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
  assert.deepEqual(
    store.calls.map(([method]) => method),
    ["get", "get", "update", "get", "get", "update"],
  )
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "pinned", currentRoute: "claude", turnsOnCurrent: 2 }),
  )
  assert.deepEqual(
    announcements.map(({ mode, reused, route }) => ({ mode, reused, route })),
    [
      { mode: "pinned", reused: false, route: "claude" },
      { mode: "pinned", reused: true, route: "claude" },
    ],
  )
})

test("pinned persists the capable target selected for its first request", async () => {
  const store = memorySessionClient({ "session-1": { agent: "router-manual", metadata: {} } })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: classifier("claude"),
  })
  const message = userMessage("implemente a correção", "router-manual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "pinned", currentRoute: "claude" }),
  )
})

test("pinned keeps a mutating request on its fixed legacy Claude target", async () => {
  const metadata = {
    owner: "user",
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
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("corrija o arquivo", "router-manual")
  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(message.output.message.model, {
    providerID: "claude-agent",
    modelID: "claude-opus-4-8",
  })
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "claude",
    }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
})

test("pinned keeps non-literal work on a fixed MiniMax target", async () => {
  const metadata = {
    [MANUAL_TARGET_METADATA_KEY]: {
      sessionID: "session-1",
      target: {
        agent: "minimax",
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M3",
      },
    },
  }
  const store = memorySessionClient({
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("traduza esta mensagem", "router-manual")
  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "minimax")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "minimax",
    }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
})

test("router-auto alias overrides an inherited legacy pinned target", async () => {
  const metadata = {
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
    "session-1": { agent: "router-auto", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: classifier("codex"),
  })
  const message = userMessage("corrija o arquivo", "router-auto")
  await hooks["chat.message"](message.input, message.output)

  assert.equal(store.sessions["session-1"].agent, "router-auto")
  assert.equal(message.output.message.agent, "codex")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({ mode: "auto", currentRoute: "codex" }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
})

test("manual allows repository inspection for a fixed Claude target", async () => {
  const metadata = {
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
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("inspecione o repositório", "router-manual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "claude",
    }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
})

for (const request of ["leia README.md", "abra src/app.ts", "git status"]) {
  test(`manual allows Claude workspace access in: ${request}`, async () => {
    const metadata = {
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
      "session-1": { agent: "router-manual", metadata },
    })
    const hooks = createDirectModelHandoff({
      client: store.client,
      classify: () => {
        throw new Error("a fixed manual target must not classify again")
      },
    })
    const message = userMessage(request, "router-manual")

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, "claude")
    assert.deepEqual(store.sessions["session-1"].metadata, {
      ...metadata,
      [ROUTING_STATE_METADATA_KEY]: routingState({
        mode: "pinned",
        currentRoute: "claude",
      }),
    })
  })
}

test("manual allows command execution for a fixed Claude target", async () => {
  const metadata = {
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
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("roda os testes", "router-manual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "claude",
    }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
})

test("pinned selects Claude for a file-only first request without classifying private data", async () => {
  const store = memorySessionClient({
    "session-1": { agent: "router-manual", metadata: {} },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("file-only routing must not invoke the classifier")
    },
  })
  const message = userMessage("", "router-manual")
  message.output.parts.push({
    type: "file",
    filename: "private-report.txt",
    mime: "text/plain",
    url: "data:text/plain,private-content",
  })

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "pinned", currentRoute: "claude" }),
  )
})

test("pinned keeps a file-only request on a fixed Claude target", async () => {
  const metadata = {
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
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("file-only routing must not invoke the classifier")
    },
  })
  const message = userMessage("", "router-manual")
  message.output.parts.push({ type: "file", filename: "private-report.txt" })

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "claude",
    }),
  })
})

test("pinned keeps an agent mention on a fixed Claude target", async () => {
  const metadata = {
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
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("revise a proposta", "router-manual")
  message.output.parts.push({ type: "agent", name: "private-reviewer" })

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "claude")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "claude",
    }),
  })
})

for (const [agent, providerID, modelID] of [
  ["glm", "zai-coding-plan", "glm-5.2"],
  ["codex", "openai", "gpt-5.6-sol"],
]) {
  test(`manual allows command execution for a fixed ${agent} target`, async () => {
    const metadata = {
      [MANUAL_TARGET_METADATA_KEY]: {
        sessionID: "session-1",
        target: { agent, providerID, modelID },
      },
    }
    const store = memorySessionClient({
      "session-1": { agent: "router-manual", metadata },
    })
    const hooks = createDirectModelHandoff({
      client: store.client,
      classify: () => {
        throw new Error("a fixed manual target must not classify again")
      },
    })
    const message = userMessage("rode os testes", "router-manual")

    await hooks["chat.message"](message.input, message.output)

    assert.equal(message.output.message.agent, agent)
    assert.deepEqual(message.output.message.model, { providerID, modelID })
    assert.deepEqual(store.sessions["session-1"].metadata, {
      ...metadata,
      [ROUTING_STATE_METADATA_KEY]: routingState({
        mode: "pinned",
        currentRoute: agent,
      }),
    })
    assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
  })
}

test("pinned keeps non-literal analysis on a fixed MiniMax target", async () => {
  const metadata = {
    [MANUAL_TARGET_METADATA_KEY]: {
      sessionID: "session-1",
      target: {
        agent: "minimax",
        providerID: "minimax-coding-plan",
        modelID: "MiniMax-M3",
      },
    },
  }
  const store = memorySessionClient({
    "session-1": { agent: "router-manual", metadata },
  })
  const hooks = createDirectModelHandoff({
    client: store.client,
    classify: () => {
      throw new Error("a fixed manual target must not classify again")
    },
  })
  const message = userMessage("compare as duas abordagens", "router-manual")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "minimax")
  assert.deepEqual(store.sessions["session-1"].metadata, {
    ...metadata,
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "minimax",
    }),
  })
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
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

test("router-auto explicitly selects auto mode over legacy manual metadata", async () => {
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
    classify: classifier("codex"),
  })
  const message = userMessage("planeje uma arquitetura", "router-auto")

  await hooks["chat.message"](message.input, message.output)

  assert.equal(message.output.message.agent, "codex")
  assert.equal(store.sessions["session-1"].agent, "router-auto")
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "get", "update"])
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "auto", currentRoute: "codex" }),
  )
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
    store.sessions["session-2"].metadata[ROUTING_STATE_METADATA_KEY].sessionID,
    "session-2",
  )
  assert.equal(
    store.sessions["session-2"].metadata[ROUTING_STATE_METADATA_KEY].currentRoute,
    "codex",
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
    [ROUTING_STATE_METADATA_KEY]: routingState({
      mode: "pinned",
      currentRoute: "glm",
    }),
  })
  assert.deepEqual(store.calls[2], [
    "update",
    {
      sessionID: "session-1",
      metadata: store.sessions["session-1"].metadata,
    },
    { throwOnError: true },
  ])
})

test("manual switch failure leaves metadata and the current message untouched", async () => {
  const store = memorySessionClient({
    "session-1": { agent: "router-auto", metadata: { owner: "user" } },
  })
  store.client.v2.session.switchAgent = async (parameters, options) => {
    store.calls.push(["switch-agent", structuredClone(parameters), structuredClone(options)])
    throw new Error("agent switch failed")
  }
  const hooks = createDirectModelHandoff({
    classify: classifier("claude"),
    client: store.client,
  })
  const message = userMessage("pedido", "router-manual")
  const originalMessage = structuredClone(message.output.message)
  const originalMetadata = structuredClone(store.sessions["session-1"].metadata)

  await assert.rejects(
    hooks["chat.message"](message.input, message.output),
    /agent switch failed/,
  )

  assert.deepEqual(message.output.message, originalMessage)
  assert.deepEqual(store.sessions["session-1"].metadata, originalMetadata)
  assert.deepEqual(store.calls.map(([method]) => method), ["get", "switch-agent"])
})

test("manual metadata failure leaves a retryable router-manual session", async () => {
  const store = memorySessionClient({
    "session-1": { agent: "router-auto", metadata: { owner: "user" } },
  })
  const update = store.client.session.update
  let updates = 0
  store.client.session.update = async (...args) => {
    updates += 1
    if (updates === 1) {
      store.calls.push(["update", structuredClone(args[0]), structuredClone(args[1])])
      throw new Error("metadata update failed")
    }
    return update(...args)
  }
  let classifications = 0
  const hooks = createDirectModelHandoff({
    classify: async () => {
      classifications += 1
      return classifier("glm")()
    },
    client: store.client,
  })
  const first = userMessage("primeiro", "router-manual")
  const original = structuredClone(first.output.message)

  await assert.rejects(
    hooks["chat.message"](first.input, first.output),
    /metadata update failed/,
  )

  assert.deepEqual(first.output.message, original)
  assert.equal(store.sessions["session-1"].agent, "router-manual")
  assert.deepEqual(store.sessions["session-1"].metadata, { owner: "user" })
  assert.deepEqual(
    store.calls.map(([method]) => method),
    ["get", "switch-agent", "get", "update"],
  )

  const retry = userMessage("tente novamente", "router-auto")
  await hooks["chat.message"](retry.input, retry.output)

  assert.equal(classifications, 2)
  assert.equal(retry.output.message.agent, "glm")
  assert.deepEqual(
    store.sessions["session-1"].metadata[ROUTING_STATE_METADATA_KEY],
    routingState({ mode: "auto", currentRoute: "glm" }),
  )
  assert.deepEqual(
    store.calls.map(([method]) => method),
    ["get", "switch-agent", "get", "update", "get", "get", "update"],
  )
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

test("keeps a literal read-only question on MiniMax when the classifier says so", () => {
  const questions = [
    "qual maior arquivo do repo?",
    "quantas linhas tem o README",
    "qual o maior arquivo do repositorio",
    "which file has the most lines?",
  ]
  for (const question of questions) {
    assert.equal(
      enforceMinimumRoute("minimax", question, { intent: LITERAL_READ_ONLY_INTENT }),
      "minimax",
      `expected MiniMax to keep the literal question: ${question}`,
    )
  }
})

test("still promotes MiniMax-forbidden work even under a literal intent", () => {
  const forbidden = [
    "traduza este README",
    "resuma este log",
    "reescreva esta documentacao",
  ]
  for (const request of forbidden) {
    assert.equal(
      enforceMinimumRoute("minimax", request, { intent: LITERAL_READ_ONLY_INTENT }),
      "glm",
      `expected the forbidden-intent veto to survive: ${request}`,
    )
  }
})

test("preserves the regex floor when the intent is not literal read-only", () => {
  assert.equal(
    enforceMinimumRoute("minimax", "qual maior arquivo do repo?", { intent: "other_intent" }),
    "glm",
  )
  assert.equal(enforceMinimumRoute("minimax", "qual maior arquivo do repo?", {}), "glm")
})
