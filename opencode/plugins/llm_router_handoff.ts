import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

import {
  CLAUDE_CHECKPOINT_METADATA_KEY,
  createClaudeCheckpointLifecycle,
  unwrapOpenCodeV2Context,
} from "../lib/claude_checkpoint.mjs"
import {
  buildSafeClaudeConversation,
  projectLegacyClaudeContext,
} from "../lib/claude_context.mjs"
import { createDirectModelHandoff } from "../lib/direct_handoff.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../lib/opencode_transport.mjs"
import { updateSessionMetadata } from "../lib/session_metadata.mjs"

const ROUTER_PATH = __LLM_ROUTER_PATH_LITERAL__
const ROUTER_TIMEOUT_MS = 120_000
const CHECKPOINT_TIMEOUT_MS = 30_000

function responseData(response) {
  if (
    response
    && typeof response === "object"
    && Object.prototype.hasOwnProperty.call(response, "data")
  ) return response.data
  return response
}

export default async function llmRouterHandoff({ client, directory }) {
  const v2Client = createOpenCodeV2ClientFromLegacyTransport({
    legacyClient: client,
    createV2Client: createOpencodeClient,
    directory,
  })

  async function classify(request) {
    const child = Bun.spawn([ROUTER_PATH, "--classify", "--json", "--", request], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    })
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, ROUTER_TIMEOUT_MS)

    let stdout
    let stderr
    let exitCode
    try {
      ;[stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    } finally {
      clearTimeout(timeout)
    }

    if (timedOut) throw new Error(`llm-router timed out after ${ROUTER_TIMEOUT_MS}ms`)
    if (exitCode !== 0) {
      throw new Error(`llm-router failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }
    return stdout
  }

  const handoff = createDirectModelHandoff({
    classify,
    client: v2Client,
    announce: async ({ mode, reused, target }) => {
      const label = mode === "auto"
        ? "Auto"
        : reused
          ? "Manual reutilizado"
          : "Manual fixado"
      await client.tui.showToast({
        body: {
          title: "llm-router",
          message: `${label} -> ${target.providerID}/${target.modelID}`,
          variant: "info",
          duration: 3000,
        },
        query: { directory },
      })
    },
  })

  async function readLegacyContext(sessionID) {
    const response = await client.session.messages({
      path: { id: sessionID },
      query: { directory },
      throwOnError: true,
    })
    return projectLegacyClaudeContext(response)
  }

  async function readContext(sessionID, requiredMessageID) {
    const response = await v2Client.v2.session.context(
      { sessionID },
      { throwOnError: true },
    )
    const messages = unwrapOpenCodeV2Context(response)
    if (
      messages.length > 0
      && (
        requiredMessageID === undefined
        || messages.some((message) => message?.id === requiredMessageID)
      )
    ) return messages
    return readLegacyContext(sessionID)
  }

  async function readMetadata(sessionID) {
    const response = await v2Client.session.get(
      { sessionID },
      { throwOnError: true },
    )
    const session = responseData(response)
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw new Error("OpenCode returned invalid session data for Claude checkpoint")
    }
    return session.metadata
  }

  async function writeMetadata(sessionID, metadata) {
    if (
      !metadata
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || !Object.prototype.hasOwnProperty.call(metadata, CLAUDE_CHECKPOINT_METADATA_KEY)
    ) {
      throw new Error("Claude checkpoint metadata update is invalid")
    }
    const checkpoint = metadata[CLAUDE_CHECKPOINT_METADATA_KEY]
    await updateSessionMetadata({
      sessionID,
      readMetadata,
      writeMetadata: async (currentSessionID, currentMetadata) => {
        await v2Client.session.update(
          { sessionID: currentSessionID, metadata: currentMetadata },
          { throwOnError: true },
        )
      },
      update: (currentMetadata) => ({
        ...currentMetadata,
        [CLAUDE_CHECKPOINT_METADATA_KEY]: checkpoint,
      }),
    })
  }

  async function checkpointNotice({ message }) {
    try {
      await client.tui.showToast({
        body: {
          title: "llm-router",
          message,
          variant: "warning",
          duration: 6000,
        },
        query: { directory },
      })
    } catch {
      // Feedback in the TUI must not block compaction or the active-tail fallback.
    }
  }

  async function summarizeCheckpoint(request) {
    const serializedRequest = JSON.stringify(request)
    const child = Bun.spawn([ROUTER_PATH, "--summarize", "--json"], {
      cwd: directory,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    child.stdin.write(serializedRequest)
    child.stdin.end()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, CHECKPOINT_TIMEOUT_MS)

    let stdout
    let stderr
    let exitCode
    try {
      ;[stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    } finally {
      clearTimeout(timeout)
    }
    if (timedOut) throw new Error(`checkpoint summarizer timed out after ${CHECKPOINT_TIMEOUT_MS}ms`)
    if (exitCode !== 0) {
      throw new Error(`checkpoint summarizer failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }
    return stdout.trim()
  }

  const checkpoints = createClaudeCheckpointLifecycle({
    readContext,
    readMetadata,
    writeMetadata,
    summarize: summarizeCheckpoint,
    notify: checkpointNotice,
  })

  return {
    ...handoff,
    event: async (input) => {
      if (input.event?.type !== "session.compacted") return
      const sessionID = input.event.properties?.sessionID ?? input.event.data?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return
      try {
        await checkpoints.afterCompaction({ sessionID })
      } catch {
        await checkpointNotice({
          message: "O vínculo do checkpoint local do Claude foi adiado; a próxima mensagem tentará validá-lo novamente.",
        })
      }
    },
    "experimental.session.compacting": async (input) => {
      await checkpoints.beforeCompaction({ sessionID: input.sessionID })
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "claude-agent") return
      const messages = await readContext(input.sessionID, input.message.id)
      const checkpoint = await checkpoints.contextFor({
        sessionID: input.sessionID,
        currentMessageID: input.message.id,
        messages,
      })
      const conversation = buildSafeClaudeConversation(messages, input.message.id, { checkpoint })
      output.options.safeConversation = conversation
      output.options.cwd = directory
    },
  }
}
