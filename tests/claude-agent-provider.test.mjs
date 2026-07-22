import assert from "node:assert/strict"
import test from "node:test"

import {
  bindClaudeCheckpoint,
  buildClaudeCheckpointRequest,
  CLAUDE_CHECKPOINT_METADATA_KEY,
  createClaudeCheckpointLifecycle,
  createClaudeCheckpointRecord,
  resolveClaudeCheckpoint,
  unwrapOpenCodeV2Context,
} from "../opencode/lib/claude_checkpoint.mjs"
import {
  buildSafeClaudeConversation,
  CLAUDE_SAFE_CONTEXT_MAX_BYTES,
  projectLegacyClaudeContext,
} from "../opencode/lib/claude_context.mjs"
import {
  CLAUDE_DEFAULT_MAX_OUTPUT_BYTES,
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

function queryHarness(start) {
  const calls = []
  const query = (parameters) => {
    const queue = []
    const waiters = []
    let settled = false
    let failure
    const flush = () => {
      while (waiters.length > 0 && queue.length > 0) {
        waiters.shift().resolve({ done: false, value: queue.shift() })
      }
      if (!settled || queue.length > 0) return
      while (waiters.length > 0) {
        const waiter = waiters.shift()
        if (failure) waiter.reject(failure)
        else waiter.resolve({ done: true, value: undefined })
      }
    }
    const emit = (message) => {
      if (settled) return
      queue.push(message)
      flush()
    }
    const close = () => {
      settled = true
      flush()
    }
    const fail = (error) => {
      failure = error
      settled = true
      flush()
    }
    const iterator = {
      [Symbol.asyncIterator]() { return this },
      next() {
        if (queue.length > 0) return Promise.resolve({ done: false, value: queue.shift() })
        if (settled) {
          return failure
            ? Promise.reject(failure)
            : Promise.resolve({ done: true, value: undefined })
        }
        return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
      },
      return() {
        close()
        return Promise.resolve({ done: true, value: undefined })
      },
      close,
      get closed() { return settled },
    }
    calls.push({ ...parameters, iterator })
    queueMicrotask(() => Promise.resolve(start({ close, emit, fail })).catch(fail))
    return iterator
  }
  return { calls, query }
}

function successfulHarness(result = successResult()) {
  return queryHarness(({ emit, close }) => {
    emit({ type: "assistant" })
    emit(result)
    close(0)
  })
}

function callOptions(prompt, cwd = process.cwd()) {
  const options = {
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
  if (prompt === textPrompt) {
    options.providerOptions["claude-agent"].safeConversation = visibleConversation
  }
  return options
}

const textPrompt = [
  { role: "system", content: "Stay read-only." },
  { role: "user", content: [{ type: "text", text: "pedido original" }] },
  { role: "assistant", content: [{ type: "text", text: "contexto anterior" }] },
  { role: "user", content: [{ type: "text", text: "continue" }] },
]

const visibleConversation = [
  { role: "user", content: "pedido original" },
  { role: "assistant", content: "contexto anterior" },
  { role: "user", content: "continue" },
]

test("unwraps the OpenCode 1.18.4 v2 context body inside the SDK response envelope", () => {
  const messages = [{ id: "user-1", type: "user", text: "pedido", time: { created: 1 } }]
  assert.equal(unwrapOpenCodeV2Context({ data: { data: messages } }), messages)
  assert.throws(() => unwrapOpenCodeV2Context({ data: messages }), /invalid session context/)
})

test("projects the OpenCode 1.18.4 legacy message API into safe Claude context", () => {
  const messages = projectLegacyClaudeContext({
    data: [
      {
        info: { id: "user-1", role: "user", time: { created: 1 } },
        parts: [
          { type: "text", text: "pedido " },
          { type: "text", text: "original" },
          { type: "file", url: "data:text/plain,PRIVATE" },
          { type: "agent", name: "private-agent" },
          { type: "text", text: "SYNTHETIC", synthetic: true },
        ],
      },
      {
        info: { id: "assistant-1", role: "assistant", time: { created: 2 } },
        parts: [
          { type: "reasoning", text: "PRIVATE_REASONING" },
          { type: "text", text: "resposta" },
          { type: "tool", state: { output: "PRIVATE_TOOL_OUTPUT" } },
        ],
      },
    ],
  })

  assert.deepEqual(messages, [
    {
      id: "user-1",
      type: "user",
      text: "pedido original",
      files: [{ type: "file", url: "data:text/plain,PRIVATE" }],
      agents: [{ type: "agent", name: "private-agent" }],
      time: { created: 1 },
    },
    {
      id: "assistant-1",
      type: "assistant",
      content: [{ type: "text", text: "resposta" }],
      error: undefined,
      time: { created: 2 },
    },
  ])
  assert.throws(
    () => buildSafeClaudeConversation(messages, "user-1"),
    /does not accept file attachments/,
  )
})

test("projects only the active legacy tail after the latest compaction", () => {
  const messages = projectLegacyClaudeContext({
    data: [
      {
        info: { id: "user-before", role: "user", time: { created: 1 } },
        parts: [{ type: "text", text: "PRE_COMPACTION_SECRET" }],
      },
      {
        info: { id: "assistant-before", role: "assistant", parentID: "user-before", time: { created: 2 } },
        parts: [{ type: "text", text: "OLD_ASSISTANT_SECRET" }],
      },
      {
        info: { id: "compaction-user", role: "user", time: { created: 3 } },
        parts: [{ type: "compaction", id: "compaction-1", auto: true }],
      },
      {
        info: { id: "compaction-summary", role: "assistant", parentID: "compaction-user", time: { created: 4 } },
        parts: [{ type: "text", text: "UNTRUSTED_COMPACTION_SUMMARY" }],
      },
      {
        info: { id: "user-current", role: "user", time: { created: 5 } },
        parts: [
          { type: "text", text: "IGNORED_SECRET", ignored: true },
          { type: "text", text: "pedido atual" },
        ],
      },
    ],
  })

  assert.deepEqual(messages, [
    {
      id: "compaction-1",
      type: "compaction",
      time: { created: 3 },
    },
    {
      id: "user-current",
      type: "user",
      text: "pedido atual",
      files: [],
      agents: [],
      time: { created: 5 },
    },
  ])
  const conversation = buildSafeClaudeConversation(messages, "user-current")
  assert.deepEqual(conversation, [{ role: "user", content: "pedido atual" }])
  assert.equal(JSON.stringify(conversation).includes("SECRET"), false)
  assert.equal(JSON.stringify(conversation).includes("SUMMARY"), false)
})

test("fails closed on malformed OpenCode legacy messages", () => {
  assert.throws(() => projectLegacyClaudeContext({ data: {} }), /invalid session messages/)
  assert.throws(
    () => projectLegacyClaudeContext({ data: [{ info: { id: "user-1", role: "user" }, parts: [{ type: "text" }] }] }),
    /invalid user text/,
  )
})

test("uses only the current user message without plugin-approved context", () => {
  const serialized = serializeClaudePrompt(textPrompt)
  assert.deepEqual(serialized, { request: "continue" })
})

test("sends plugin-approved user and assistant history while discarding system text", () => {
  const serialized = serializeClaudePrompt(textPrompt, visibleConversation)
  assert.match(serialized.request, /^Continue the conversation in the JSON array below\./)
  const transcript = JSON.parse(serialized.request.slice(serialized.request.indexOf("\n\n") + 2))
  assert.deepEqual(transcript, visibleConversation)
  assert.equal(serialized.request.includes("Stay read-only."), false)
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

test("builds approved context from projected v2 messages through the unique current ID", () => {
  const conversation = buildSafeClaudeConversation([
    {
      id: "system-1",
      type: "system",
      text: "OLD_SYSTEM_SECRET_818a",
    },
    {
      id: "user-1",
      type: "user",
      text: "pedido original",
      time: { created: 1 },
    },
    {
      id: "assistant-1",
      type: "assistant",
      content: [
        { type: "reasoning", id: "reasoning-1", text: "OLD_REASONING_SECRET_f1d2" },
        { type: "text", text: "resposta visível" },
        { type: "tool", id: "tool-1", name: "read", state: { result: "OLD_RESULT_SECRET_4dc3" } },
      ],
    },
    {
      id: "compaction-1",
      type: "compaction",
      reason: "auto",
      summary: "OLD_SUMMARY_SECRET_7ac4",
      recent: "OLD_RECENT_SECRET_9f31",
      time: { created: 2 },
    },
    {
      id: "shell-1",
      type: "shell",
      command: "env",
      output: "OLD_SHELL_SECRET_1ada",
      time: { created: 3 },
    },
    {
      id: "user-2",
      type: "user",
      text: "continue",
      time: { created: 4 },
    },
    {
      id: "future-1",
      type: "user",
      text: "FUTURE_SECRET_d942",
      time: { created: 5 },
    },
  ], "user-2")

  assert.deepEqual(conversation, [
    { role: "user", content: "pedido original" },
    { role: "assistant", content: "resposta visível" },
    { role: "user", content: "continue" },
  ])
  assert.equal(JSON.stringify(conversation).includes("SECRET"), false)
})

test("keeps historical user text while excluding file and agent attachment data", () => {
  const conversation = buildSafeClaudeConversation([
    {
      id: "user-file",
      type: "user",
      text: "Considere o contrato que enviei antes.",
      files: [{ uri: "file:///FILE_ATTACHMENT_SECRET_37ab", name: "FILE_NAME_SECRET_87ca" }],
      time: { created: 1 },
    },
    {
      id: "user-agent",
      type: "user",
      text: "O agente anterior confirmou a porta 4317.",
      agents: [{ name: "AGENT_NAME_SECRET_49dc", prompt: "AGENT_PROMPT_SECRET_71fe" }],
      time: { created: 2 },
    },
    { id: "user-current", type: "user", text: "continue", time: { created: 3 } },
  ], "user-current")

  assert.deepEqual(conversation, [
    { role: "user", content: "Considere o contrato que enviei antes." },
    { role: "user", content: "O agente anterior confirmou a porta 4317." },
    { role: "user", content: "continue" },
  ])
  assert.equal(JSON.stringify(conversation).includes("SECRET"), false)
})

test("fails closed on attachments in the projected current OpenCode message", () => {
  assert.throws(
    () => buildSafeClaudeConversation([
      {
        id: "user-current",
        type: "user",
        text: "analise o arquivo",
        files: [{ uri: "file:///private.txt" }],
        time: { created: 1 },
      },
    ], "user-current"),
    /does not accept file attachments/,
  )
  assert.throws(
    () => buildSafeClaudeConversation([
      {
        id: "user-current",
        type: "user",
        text: "consulte o agente",
        agents: [{ name: "AGENT_ATTACHMENT_SECRET_b276" }],
        time: { created: 1 },
      },
    ], "user-current"),
    /does not accept agent attachments/,
  )
})

test("requires one projected current ID and excludes assistant messages with errors", () => {
  const messages = [
    { id: "user-1", type: "user", text: "pedido", time: { created: 1 } },
    {
      id: "assistant-error",
      type: "assistant",
      content: [{ type: "text", id: "text-error", text: "ERROR_SECRET_87ca" }],
      error: { name: "UnknownError", data: { message: "failed" } },
      time: { created: 2 },
    },
    { id: "user-2", type: "user", text: "continue", time: { created: 3 } },
  ]

  assert.deepEqual(buildSafeClaudeConversation(messages, "user-2"), [
    { role: "user", content: "pedido" },
    { role: "user", content: "continue" },
  ])
  assert.throws(() => buildSafeClaudeConversation(messages, "missing"), /exactly once/)
  assert.throws(
    () => buildSafeClaudeConversation([...messages, messages[2]], "user-2"),
    /exactly once/,
  )
})

test("budgets projected context before transcript serialization and always keeps the current message", () => {
  const messages = [
    { id: "user-first", type: "user", text: "primeiro fato", time: { created: 1 } },
    ...Array.from({ length: 30 }, (_, index) => ({
      id: `assistant-${index}`,
      type: "assistant",
      content: [{ type: "text", id: `text-${index}`, text: `histórico-${index}-${"x".repeat(300)}` }],
      time: { created: index + 2 },
    })),
    { id: "user-current", type: "user", text: "MENSAGEM_ATUAL_única", time: { created: 40 } },
  ]
  const conversation = buildSafeClaudeConversation(messages, "user-current", { maxBytes: 2_048 })
  const serialized = serializeClaudePrompt(
    [{ role: "user", content: [{ type: "text", text: "MENSAGEM_ATUAL_única" }] }],
    conversation,
  )

  assert.equal(conversation.contextMetadata.truncated, true)
  assert.equal(conversation.contextMetadata.droppedMessages > 0, true)
  assert.equal(conversation.at(-1).content, "MENSAGEM_ATUAL_única")
  assert.equal(conversation.filter((message) => message.content === "MENSAGEM_ATUAL_única").length, 1)
  assert.equal(Buffer.byteLength(serialized.request, "utf8") <= 2_048, true)
  assert.throws(
    () => buildSafeClaudeConversation([
      { id: "oversized", type: "user", text: "ç".repeat(800), time: { created: 1 } },
    ], "oversized", { maxBytes: 1_024 }),
    /current user message exceeds the 1024-byte safe context budget/,
  )
})

test("keeps ordinary long context until OpenCode approaches its advertised window", () => {
  const messages = [
    { id: "user-first", type: "user", text: "fato inicial", time: { created: 1 } },
    ...Array.from({ length: 400 }, (_, index) => ({
      id: `assistant-${index}`,
      type: "assistant",
      content: [{ type: "text", id: `text-${index}`, text: `turno-${index}-${"x".repeat(1_000)}` }],
      time: { created: index + 2 },
    })),
    { id: "user-current", type: "user", text: "continue", time: { created: 500 } },
  ]
  const conversation = buildSafeClaudeConversation(messages, "user-current")

  assert.equal(CLAUDE_MAX_INPUT_BYTES, 2 * 1024 * 1024)
  assert.equal(CLAUDE_SAFE_CONTEXT_MAX_BYTES < CLAUDE_MAX_INPUT_BYTES, true)
  assert.equal(conversation.contextMetadata.truncated, false)
  assert.equal(conversation.length, 402)
})

test("includes a checkpoint only when its compaction ID is present before the current message", () => {
  const messages = [
    { id: "compaction-1", type: "compaction", summary: "native", recent: "native", time: { created: 1 } },
    { id: "user-current", type: "user", text: "continue", time: { created: 2 } },
  ]
  const checkpoint = {
    schemaVersion: 1,
    sessionID: "session-1",
    status: "ready",
    compactionID: "compaction-1",
    summary: "fato validado",
    source: { firstMessageID: "user-1", lastMessageID: "user-1", selectedMessageCount: 1 },
  }
  const accepted = buildSafeClaudeConversation(messages, "user-current", { checkpoint })
  const rejected = buildSafeClaudeConversation(messages, "user-current", {
    checkpoint: { ...checkpoint, compactionID: "other" },
  })

  assert.match(accepted[0].content, /fato validado/)
  assert.equal(accepted.contextMetadata.checkpointIncluded, true)
  assert.equal(JSON.stringify(rejected).includes("fato validado"), false)
  assert.equal(rejected.contextMetadata.checkpointIncluded, false)
})

test("creates a bounded checkpoint request from allowed text only", () => {
  const request = buildClaudeCheckpointRequest({
    sessionID: "session-1",
    maxSourceBytes: 512,
    messages: [
      { id: "compaction-old", type: "compaction", summary: "NATIVE_SECRET_1", recent: "NATIVE_SECRET_2", time: { created: 1 } },
      { id: "system-1", type: "system", text: "SYSTEM_SECRET_3", time: { created: 2 } },
      { id: "synthetic-1", type: "synthetic", text: "SYNTHETIC_SECRET_4", time: { created: 3 } },
      { id: "shell-1", type: "shell", command: "cat", output: "SHELL_SECRET_5", time: { created: 4 } },
      { id: "user-1", type: "user", text: "O projeto usa a porta 4317.", time: { created: 5 } },
      {
        id: "user-file",
        type: "user",
        text: "O histórico menciona um arquivo enviado.",
        files: [{ uri: "file:///FILE_ATTACHMENT_SECRET_6", name: "FILE_NAME_SECRET_6" }],
        time: { created: 6 },
      },
      {
        id: "user-agent",
        type: "user",
        text: "Outro agente confirmou o requisito de privacidade.",
        agents: [{ name: "AGENT_NAME_SECRET_6", prompt: "AGENT_PROMPT_SECRET_6" }],
        time: { created: 6.5 },
      },
      {
        id: "assistant-1",
        type: "assistant",
        content: [
          { type: "reasoning", id: "reasoning-1", text: "REASONING_SECRET_7" },
          { type: "text", id: "text-1", text: "A decisão foi manter Manual fixo." },
          { type: "tool", id: "tool-1", name: "read", state: { result: "TOOL_SECRET_8" } },
        ],
        time: { created: 7 },
      },
      {
        id: "assistant-error",
        type: "assistant",
        content: [{ type: "text", id: "text-2", text: "ERROR_SECRET_9" }],
        error: { name: "UnknownError", data: { message: "failed" } },
        time: { created: 8 },
      },
      { id: "user-2", type: "user", text: "A pendência é validar compactação.", time: { created: 9 } },
    ],
  })

  assert.equal(request.schema_version, 1)
  assert.equal(request.session_id, "session-1")
  assert.deepEqual(request.source, {
    first_message_id: "user-1",
    last_message_id: "user-2",
    selected_message_count: 5,
  })
  assert.deepEqual(request.messages, [
    { role: "user", content: "O projeto usa a porta 4317." },
    { role: "user", content: "O histórico menciona um arquivo enviado." },
    { role: "user", content: "Outro agente confirmou o requisito de privacidade." },
    { role: "assistant", content: "A decisão foi manter Manual fixo." },
    { role: "user", content: "A pendência é validar compactação." },
  ])
  assert.deepEqual(request.prior_compaction_ids, ["compaction-old"])
  assert.equal(JSON.stringify(request).includes("SECRET"), false)
})

test("binds a checkpoint to exactly one new compaction and retains golden facts", () => {
  const request = buildClaudeCheckpointRequest({
    sessionID: "session-1",
    messages: [
      { id: "compaction-old", type: "compaction", summary: "ignored", recent: "ignored", time: { created: 1 } },
      { id: "user-1", type: "user", text: "porta 4317", time: { created: 2 } },
      { id: "assistant-1", type: "assistant", content: [{ type: "text", id: "t1", text: "Manual fixo" }], time: { created: 3 } },
      { id: "user-2", type: "user", text: "validar compactação", time: { created: 4 } },
    ],
  })
  const pending = createClaudeCheckpointRecord({
    createdAt: 10,
    request,
    summaryOutput: JSON.stringify({
      schema_version: 1,
      summary: "Porta: 4317. Decisão: Manual fixo. Pendência: validar compactação.",
    }),
  })
  const context = [
    { id: "compaction-new", type: "compaction", summary: "NATIVE_SECRET", recent: "RECENT_SECRET", time: { created: 11 } },
    { id: "user-current", type: "user", text: "continue", time: { created: 12 } },
  ]
  const bound = bindClaudeCheckpoint(pending, { sessionID: "session-1", messages: context })
  const resolved = resolveClaudeCheckpoint(bound, {
    sessionID: "session-1",
    currentMessageID: "user-current",
    messages: context,
  })

  assert.equal(bound.compactionID, "compaction-new")
  assert.match(resolved.summary, /4317/)
  assert.match(resolved.summary, /Manual fixo/)
  assert.match(resolved.summary, /validar compactação/)
  assert.equal(resolved.summary.includes("SECRET"), false)
  assert.throws(
    () => bindClaudeCheckpoint(pending, {
      sessionID: "session-1",
      messages: [...context, { id: "compaction-other", type: "compaction", summary: "x", recent: "y", time: { created: 12 } }],
    }),
    /exactly one new compaction/,
  )
})

test("rejects checkpoints whose session, compaction, or covered range is not proven", () => {
  const request = buildClaudeCheckpointRequest({
    sessionID: "session-1",
    messages: [{ id: "user-1", type: "user", text: "fato", time: { created: 1 } }],
  })
  const pending = createClaudeCheckpointRecord({
    createdAt: 10,
    request,
    summaryOutput: JSON.stringify({ schema_version: 1, summary: "fato" }),
  })
  const context = [
    { id: "compaction-new", type: "compaction", summary: "native", recent: "native", time: { created: 11 } },
    { id: "user-current", type: "user", text: "continue", time: { created: 12 } },
  ]
  const bound = bindClaudeCheckpoint(pending, { sessionID: "session-1", messages: context })

  assert.equal(resolveClaudeCheckpoint(bound, {
    sessionID: "other-session",
    currentMessageID: "user-current",
    messages: context,
  }), undefined)
  assert.equal(resolveClaudeCheckpoint({ ...bound, compactionID: "unknown" }, {
    sessionID: "session-1",
    currentMessageID: "user-current",
    messages: context,
  }), undefined)
  assert.equal(resolveClaudeCheckpoint({ ...bound, source: { ...bound.source, lastMessageID: "" } }, {
    sessionID: "session-1",
    currentMessageID: "user-current",
    messages: context,
  }), undefined)
})

test("runs one local summary per compaction and carries checkpoint facts into the next one", async () => {
  let metadata = { "user.metadata": "preserved" }
  let context = [
    { id: "user-1", type: "user", text: "A porta é 4317.", time: { created: 1 } },
    { id: "assistant-1", type: "assistant", content: [{ type: "text", id: "t1", text: "Confirmado." }], time: { created: 2 } },
  ]
  let clock = 10
  const summaryRequests = []
  const notices = []
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => context,
    readMetadata: async () => metadata,
    writeMetadata: async (_sessionID, next) => { metadata = next },
    summarize: async (request) => {
      summaryRequests.push(request)
      const source = JSON.stringify(request.messages)
      if (summaryRequests.length === 1) {
        assert.match(source, /4317/)
        return JSON.stringify({ schema_version: 1, summary: "Fato persistente: porta 4317." })
      }
      assert.match(source, /Previous verified checkpoint/)
      assert.match(source, /porta 4317/)
      assert.match(source, /Manual permanece fixo/)
      return JSON.stringify({
        schema_version: 1,
        summary: "Fato persistente: porta 4317. Decisão nova: Manual permanece fixo.",
      })
    },
    notify: async (notice) => { notices.push(notice) },
    now: () => clock,
  })

  await Promise.all([
    lifecycle.beforeCompaction({ sessionID: "session-1" }),
    lifecycle.beforeCompaction({ sessionID: "session-1" }),
  ])
  assert.equal(summaryRequests.length, 1)
  assert.equal(metadata["user.metadata"], "preserved")
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].status, "pending")

  context = [
    { id: "compaction-1", type: "compaction", summary: "NATIVE_SECRET_1", recent: "RECENT_SECRET_1", time: { created: 11 } },
    { id: "user-2", type: "user", text: "Manual permanece fixo.", time: { created: 12 } },
  ]
  await lifecycle.afterCompaction({ sessionID: "session-1" })
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].compactionID, "compaction-1")

  clock = 20
  await lifecycle.beforeCompaction({ sessionID: "session-1" })
  assert.equal(summaryRequests.length, 2)
  assert.equal(JSON.stringify(summaryRequests[1]).includes("NATIVE_SECRET"), false)

  context = [
    { id: "compaction-2", type: "compaction", summary: "NATIVE_SECRET_2", recent: "RECENT_SECRET_2", time: { created: 21 } },
    { id: "user-3", type: "user", text: "continue", time: { created: 22 } },
  ]
  await lifecycle.afterCompaction({ sessionID: "session-1" })
  const resolved = await lifecycle.contextFor({
    sessionID: "session-1",
    currentMessageID: "user-3",
    messages: context,
  })
  assert.match(resolved.summary, /porta 4317/)
  assert.match(resolved.summary, /Manual permanece fixo/)
  assert.deepEqual(notices, [])
})

test("persists a failed checkpoint and visibly falls back to the active tail", async () => {
  let metadata = {}
  let context = [{ id: "user-1", type: "user", text: "pedido", time: { created: 1 } }]
  const notices = []
  let summaryCalls = 0
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => context,
    readMetadata: async () => metadata,
    writeMetadata: async (_sessionID, next) => { metadata = next },
    summarize: async () => {
      summaryCalls += 1
      throw new Error("invalid JSON")
    },
    notify: async (notice) => { notices.push(notice) },
    now: () => 10,
  })

  await lifecycle.beforeCompaction({ sessionID: "session-1" })
  assert.equal(summaryCalls, 1)
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].result.status, "failed")
  assert.equal(notices[0].code, "checkpoint_failed")

  context = [
    { id: "compaction-1", type: "compaction", summary: "native", recent: "native", time: { created: 11 } },
    { id: "user-2", type: "user", text: "continue", time: { created: 12 } },
  ]
  await lifecycle.afterCompaction({ sessionID: "session-1" })
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].compactionID, "compaction-1")
  assert.equal(await lifecycle.contextFor({
    sessionID: "session-1",
    currentMessageID: "user-2",
    messages: context,
  }), undefined)
  assert.equal(notices.at(-1).code, "checkpoint_tail_fallback")
  assert.equal(notices.at(-1).message.includes("cauda ativa"), true)
})

test("bounds remembered active-tail fallback warnings", async () => {
  const notices = []
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => [],
    readMetadata: async () => ({}),
    writeMetadata: async () => {},
    summarize: async () => "unused",
    notify: async (notice) => { notices.push(notice) },
    maxWarnedFallbacks: 2,
  })

  async function useFallback(sessionID, compactionID) {
    const messages = [
      { id: compactionID, type: "compaction", time: { created: 1 } },
      { id: `${sessionID}-current`, type: "user", text: "continue", time: { created: 2 } },
    ]
    await lifecycle.contextFor({
      sessionID,
      currentMessageID: `${sessionID}-current`,
      messages,
    })
  }

  await useFallback("session-1", "compaction-1")
  await useFallback("session-2", "compaction-2")
  await useFallback("session-3", "compaction-3")
  await useFallback("session-1", "compaction-1")

  assert.equal(notices.length, 4)
  assert.equal(notices.every((notice) => notice.code === "checkpoint_tail_fallback"), true)
})

test("binds lazily in chat context when the compacted event was not delivered", async () => {
  let metadata = {}
  let context = [{ id: "user-1", type: "user", text: "porta 4317", time: { created: 1 } }]
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => context,
    readMetadata: async () => metadata,
    writeMetadata: async (_sessionID, next) => { metadata = next },
    summarize: async () => JSON.stringify({ schema_version: 1, summary: "porta 4317" }),
    now: () => 10,
  })
  await lifecycle.beforeCompaction({ sessionID: "session-1" })
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].status, "pending")

  context = [
    { id: "compaction-1", type: "compaction", summary: "native", recent: "native", time: { created: 11 } },
    { id: "user-2", type: "user", text: "continue", time: { created: 12 } },
  ]
  const resolved = await lifecycle.contextFor({
    sessionID: "session-1",
    currentMessageID: "user-2",
    messages: context,
  })
  assert.equal(resolved.compactionID, "compaction-1")
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].status, "bound")
})

test("keeps a pending checkpoint when the compacted event arrives before v2 context", async () => {
  let metadata = {}
  let context = [{ id: "user-1", type: "user", text: "porta 4317", time: { created: 1 } }]
  const notices = []
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => context,
    readMetadata: async () => metadata,
    writeMetadata: async (_sessionID, next) => { metadata = next },
    summarize: async () => JSON.stringify({ schema_version: 1, summary: "porta 4317" }),
    notify: async (notice) => { notices.push(notice) },
    now: () => 10,
  })
  await lifecycle.beforeCompaction({ sessionID: "session-1" })
  await lifecycle.afterCompaction({ sessionID: "session-1" })
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].status, "pending")
  assert.equal(notices.at(-1).code, "checkpoint_binding_deferred")

  context = [
    { id: "compaction-1", type: "compaction", summary: "native", recent: "native", time: { created: 11 } },
    { id: "user-2", type: "user", text: "continue", time: { created: 12 } },
  ]
  const resolved = await lifecycle.contextFor({
    sessionID: "session-1",
    currentMessageID: "user-2",
    messages: context,
  })
  assert.equal(resolved.compactionID, "compaction-1")
  assert.equal(metadata[CLAUDE_CHECKPOINT_METADATA_KEY].status, "bound")
})

test("contains post-compaction read failures so the event hook can continue", async () => {
  const notices = []
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => { throw new Error("temporarily unavailable") },
    readMetadata: async () => { throw new Error("temporarily unavailable") },
    writeMetadata: async () => { throw new Error("must not write") },
    summarize: async () => { throw new Error("must not summarize") },
    notify: async (notice) => { notices.push(notice) },
  })

  await assert.doesNotReject(lifecycle.afterCompaction({ sessionID: "session-1" }))
  assert.equal(notices[0].code, "checkpoint_binding_deferred")
})

test("fails closed on invalid session metadata without overwriting it", async () => {
  const original = "invalid-metadata"
  let metadata = original
  let writes = 0
  const lifecycle = createClaudeCheckpointLifecycle({
    readContext: async () => [{ id: "user-1", type: "user", text: "pedido", time: { created: 1 } }],
    readMetadata: async () => metadata,
    writeMetadata: async (_sessionID, next) => {
      writes += 1
      metadata = next
    },
    summarize: async () => JSON.stringify({ schema_version: 1, summary: "pedido" }),
    notify: async () => {},
    now: () => 10,
  })

  await lifecycle.beforeCompaction({ sessionID: "session-1" })
  assert.equal(metadata, original)
  assert.equal(writes, 0)
})

test("rejects an adulterated bound summary that exceeds the validated schema budget", () => {
  const context = [
    { id: "compaction-1", type: "compaction", summary: "native", recent: "native", time: { created: 11 } },
    { id: "user-2", type: "user", text: "continue", time: { created: 12 } },
  ]
  const adulterated = {
    schemaVersion: 1,
    sessionID: "session-1",
    status: "bound",
    compactionID: "compaction-1",
    source: { firstMessageID: "user-1", lastMessageID: "user-1", selectedMessageCount: 1 },
    result: { status: "ready", summary: "x".repeat(32 * 1024 + 1) },
  }
  assert.equal(resolveClaudeCheckpoint(adulterated, {
    sessionID: "session-1",
    currentMessageID: "user-2",
    messages: context,
  }), undefined)
})

test("keeps a single current user request unchanged", () => {
  assert.deepEqual(
    serializeClaudePrompt([{ role: "user", content: [{ type: "text", text: "pedido isolado" }] }]),
    { request: "pedido isolado" },
  )
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

test("rejects oversized input before calling the Agent SDK", async () => {
  let queryCalls = 0
  const model = createClaudeAgent({
    query: () => {
      queryCalls += 1
      throw new Error("query must not be called")
    },
  }).languageModel("claude-opus-4-8")
  const oversized = [{
    role: "user",
    content: [{ type: "text", text: "x".repeat(CLAUDE_MAX_INPUT_BYTES + 1) }],
  }]

  await assert.rejects(
    model.doGenerate(callOptions(oversized)),
    new RegExp(`exceeds the ${CLAUDE_MAX_INPUT_BYTES}-byte input limit`),
  )
  assert.equal(queryCalls, 0)
})

test("applies the input limit to the complete visible transcript", () => {
  assert.throws(
    () => serializeClaudePrompt(
      [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      [
        { role: "user", content: "x".repeat(CLAUDE_MAX_INPUT_BYTES - 40) },
        { role: "assistant", content: "historical answer" },
        { role: "user", content: "continue" },
      ],
    ),
    new RegExp(`exceeds the ${CLAUDE_MAX_INPUT_BYTES}-byte input limit`),
  )
})

test("reports maxOutputTokens as unsupported without treating UTF-8 bytes as tokens", async () => {
  const harness = successfulHarness(successResult("ação concluída"))
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.maxOutputTokens = 3

  const generated = await model.doGenerate(options)
  assert.equal(generated.content[0].text, "ação concluída")
  assert.deepEqual(generated.warnings, [{
    type: "unsupported",
    feature: "maxOutputTokens",
    details: "Claude Agent SDK does not expose an enforceable output-token limit",
  }])
  assert.equal(harness.calls[0].iterator.closed, true)
})

test("stops progressive output above the independent maxOutputBytes guard", async () => {
  const harness = queryHarness(({ emit }) => {
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
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.providerOptions["claude-agent"].maxOutputBytes = 10
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
  assert.match(parts.at(-1).error.message, /exceeded maxOutputBytes 10/)
  assert.equal(harness.calls[0].iterator.closed, true)
  assert.equal(parts.filter((part) => ["finish", "error"].includes(part.type)).length, 1)
})

test("rejects a non-streamed final result above maxOutputBytes", async () => {
  const harness = successfulHarness(successResult("á".repeat(6)))
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.providerOptions["claude-agent"].maxOutputBytes = 10

  await assert.rejects(model.doGenerate(options), /exceeded maxOutputBytes 10/)
  assert.equal(harness.calls[0].iterator.closed, true)
})

test("uses a bounded byte guard by default and validates explicit maxOutputBytes", async () => {
  assert.equal(Number.isInteger(CLAUDE_DEFAULT_MAX_OUTPUT_BYTES), true)
  assert.equal(CLAUDE_DEFAULT_MAX_OUTPUT_BYTES > CLAUDE_MAX_INPUT_BYTES, true)

  const harness = successfulHarness()
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")
  const options = callOptions(textPrompt)
  options.providerOptions["claude-agent"].maxOutputBytes = 0
  await assert.rejects(model.doGenerate(options), /maxOutputBytes must be a positive integer/)
  assert.equal(harness.calls.length, 0)
})

test("surfaces projected-context truncation as a provider warning", async () => {
  const current = "continue"
  const messages = [
    { id: "user-1", type: "user", text: "pedido", time: { created: 1 } },
    ...Array.from({ length: 20 }, (_, index) => ({
      id: `assistant-${index}`,
      type: "assistant",
      content: [{ type: "text", id: `text-${index}`, text: "x".repeat(300) }],
      time: { created: index + 2 },
    })),
    { id: "user-current", type: "user", text: current, time: { created: 30 } },
  ]
  const conversation = buildSafeClaudeConversation(messages, "user-current", { maxBytes: 1_024 })
  const prompt = [{ role: "user", content: [{ type: "text", text: current }] }]
  const options = callOptions(prompt)
  options.providerOptions["claude-agent"].safeConversation = conversation
  const harness = successfulHarness()
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")

  const generated = await model.doGenerate(options)
  assert.deepEqual(generated.warnings, [{
    type: "other",
    message: `Claude context was truncated by ${conversation.contextMetadata.droppedMessages} messages before serialization`,
  }])
})

test("uses the official Claude stop reason and usage when token output cannot be enforced", async () => {
  const result = successResult("partial")
  result.stop_reason = "max_tokens"
  result.modelUsage["claude-opus-4-8"].outputTokens = 321
  const harness = successfulHarness(result)
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")

  const generated = await model.doGenerate(callOptions(textPrompt))
  assert.deepEqual(generated.finishReason, { unified: "length", raw: "max_tokens" })
  assert.equal(generated.usage.outputTokens.total, 321)
})

test("implements LanguageModelV3 generation through the Claude Agent SDK", async () => {
  const harness = successfulHarness()
  const provider = createClaudeAgent({ name: "claude-agent", query: harness.query })
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
  assert.deepEqual(generated.warnings, [])

  const received = harness.calls[0]
  assert.equal(received.options.cwd, process.cwd())
  assert.match(received.prompt, /^Continue the conversation in the JSON array below\./)
  assert.equal(received.prompt.includes("pedido original"), true)
  assert.equal(received.prompt.includes("contexto anterior"), true)
  assert.equal(received.prompt.includes("continue"), true)
  assert.deepEqual(received.options.tools, { type: "preset", preset: "claude_code" })
  assert.equal(received.options.permissionMode, "auto")
  assert.equal(received.options.pathToClaudeCodeExecutable, process.execPath)
  assert.equal(JSON.stringify(received.options).includes("external_tool"), false)
  assert.equal(received.options.systemPrompt.append.includes("Stay read-only."), false)
  assert.equal(received.prompt.includes("Stay read-only."), false)
})

test("streams Agent SDK text deltas before the final result supplies usage", async () => {
  let releaseResult
  const resultGate = new Promise((resolve) => { releaseResult = resolve })
  let markDelta
  const deltaWritten = new Promise((resolve) => { markDelta = resolve })
  const harness = queryHarness(async ({ emit, close }) => {
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
  const model = createClaudeAgent({ query: harness.query }).languageModel("claude-opus-4-8")
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
  assert.deepEqual(parts.at(-1).finishReason, { unified: "stop", raw: "end_turn" })
  assert.equal(parts.filter((part) => ["finish", "error"].includes(part.type)).length, 1)
})

test("requires cwd and exposes Agent SDK failures as stream errors", async () => {
  const harness = successfulHarness()
  const model = createClaudeAgent({ query: harness.query, claudePath: process.execPath }).languageModel("claude-opus-4-8")
  await assert.rejects(
    model.doGenerate({ prompt: textPrompt, providerOptions: {} }),
    /requires a workspace cwd/,
  )
  assert.equal(harness.calls.length, 0)

  const failed = queryHarness(({ fail }) => {
    fail(new Error("authentication failed"))
  })
  const failedModel = createClaudeAgent({ query: failed.query }).languageModel("claude-opus-4-8")
  const response = await failedModel.doStream(callOptions(textPrompt))
  const parts = []
  for await (const part of response.stream) parts.push(part)
  assert.deepEqual(parts.map((part) => part.type), ["stream-start", "error"])
  assert.match(parts[1].error.message, /authentication failed/)
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
