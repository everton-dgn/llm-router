import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  CLAUDE_CHECKPOINT_METADATA_KEY,
  createClaudeCheckpointLifecycle,
  unwrapOpenCodeV2Context,
} from "../lib/claude_checkpoint.mjs"
import {
  buildSafeClaudeConversation,
  projectLegacyClaudeContext,
} from "../lib/claude_context.mjs"
import { isManagedRouterAgent } from "../lib/adaptive_routing.mjs"
import { createDirectModelHandoff } from "../lib/direct_handoff.mjs"
import {
  loadExecutionPolicy,
  resolveExecutionPolicy,
} from "../lib/execution_policy.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../lib/opencode_transport.mjs"
import { assertClassifierRequestSize } from "../lib/route_contract.mjs"
import {
  parseRouteManifest,
  parseRouteManifestOverride,
} from "../lib/route_manifest.mjs"
import { createRouterControlRuntime } from "../lib/router_control.mjs"
import { createRouterAnnouncer } from "../lib/router_feedback.mjs"
import {
  NO_COMPATIBLE_ROUTE_ERROR_CODE,
  UNSUPPORTED_MEDIA_TYPE_ERROR_CODE,
} from "../lib/routing_policy.mjs"
import { updateSessionMetadata } from "../lib/session_metadata.mjs"
import {
  showStartupNotice,
  STARTUP_NOTICE_MESSAGE,
} from "../lib/startup_notice.mjs"
import { createOpenCodeUninstaller } from "../lib/uninstall.mjs"

const ROUTER_PATH = __LLM_ROUTER_PATH_LITERAL__
const ROUTER_TIMEOUT_MS = 120_000
const MANIFEST_TIMEOUT_MS = 10_000
const CHECKPOINT_TIMEOUT_MS = 30_000
const CONFIG_DIR = fileURLToPath(new URL("..", import.meta.url))
const POLICY_DEFAULTS_PATH = fileURLToPath(
  new URL("../llm-router.policy.defaults.json", import.meta.url),
)
const POLICY_GLOBAL_PATH = fileURLToPath(
  new URL("../llm-router.policy.json", import.meta.url),
)

function responseData(response) {
  if (
    response
    && typeof response === "object"
    && Object.prototype.hasOwnProperty.call(response, "data")
  ) return response.data
  return response
}

async function applyProjectRouteOverride(manifest, directory) {
  const overridePath = join(directory, ".opencode", "llm-router.routes.json")
  let raw
  try {
    raw = await readFile(overridePath, "utf8")
  } catch (error) {
    if (error?.code === "ENOENT") return manifest
    throw error
  }
  return parseRouteManifestOverride(raw, manifest, overridePath)
}

async function loadRouteManifest(directory) {
  const child = Bun.spawn([ROUTER_PATH, "--manifest", "--json"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill()
  }, MANIFEST_TIMEOUT_MS)

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
  if (timedOut) throw new Error(`llm-router manifest timed out after ${MANIFEST_TIMEOUT_MS}ms`)
  if (exitCode !== 0) {
    throw new Error(`llm-router manifest failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
  }
  return parseRouteManifest(stdout)
}

export default async function llmRouterHandoff({ client, directory }) {
  const v2Client = createOpenCodeV2ClientFromLegacyTransport({
    legacyClient: client,
    createV2Client: createOpencodeClient,
    directory,
  })
  const uninstaller = await createOpenCodeUninstaller({ configDir: CONFIG_DIR })
  const manifest = await applyProjectRouteOverride(
    await loadRouteManifest(directory),
    directory,
  )

  const announcer = createRouterAnnouncer()

  async function showRouterToast({ mode, profile, target }) {
    const destination = target
      ? `${target.providerID}/${target.modelID}`
      : "configuration updated"
    await client.tui.showToast({
      body: {
        title: "llm-router",
        message: `${mode} -> ${destination} · ${profile}`,
        variant: "info",
        // A slash command always confirms itself. Routing repeats the same
        // state on most messages, so its toast fires only on a change. Both
        // stay short: the notice is a glance, not something to read through.
        duration: 3000,
      },
      query: { directory },
    })
  }

  async function showRouterAlert(message, variant) {
    await client.tui.showToast({
      body: {
        title: "llm-router",
        message,
        variant,
        duration: 6000,
      },
      query: { directory },
    })
  }

  const control = createRouterControlRuntime({
    directory,
    sessionClient: v2Client.session,
    v2SessionClient: v2Client.v2.session,
    loadPolicy: () => loadExecutionPolicy({
      defaultsPath: POLICY_DEFAULTS_PATH,
      globalPath: POLICY_GLOBAL_PATH,
      projectPath: join(directory, ".opencode", "llm-router.policy.json"),
    }),
    resolvePolicy: resolveExecutionPolicy,
    uninstall: (argumentsText) => uninstaller.execute(argumentsText),
  })
  showStartupNotice(() => client.tui.showToast({
    body: {
      title: "llm-router",
      message: STARTUP_NOTICE_MESSAGE,
      variant: "info",
      duration: 5000,
    },
    query: { directory },
  }))

  async function classify(request) {
    assertClassifierRequestSize(request)
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
    manifest,
    // The routing status toast already reports the destination, so only a
    // forced fallback earns its own message.
    announce: async ({ mediaFallback }) => {
      if (!mediaFallback) return
      await showRouterAlert(
        `${mediaFallback.from} -> ${mediaFallback.to}: `
        + `${mediaFallback.unsupported.join(", ")} not supported`,
        "warning",
      )
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
    dispose: async () => {
      await control.dispose()
    },
    "command.execute.before": control.commandBefore,
    "tool.execute.before": control.toolBefore,
    "chat.message": async (input, output) => {
      const selectedAgent = input.agent ?? output.message?.agent
      if (!isManagedRouterAgent(selectedAgent)) return
      const routingAgent = await control.routingAgent(input.sessionID, selectedAgent)
      try {
        await handoff["chat.message"]({ ...input, agent: routingAgent }, output)
      } catch (error) {
        // The message stops before any worker sees it, either because no
        // route reads the attachments or because none also supports the
        // request, so the reason stays visible instead of failing silently.
        if ([
          UNSUPPORTED_MEDIA_TYPE_ERROR_CODE,
          NO_COMPATIBLE_ROUTE_ERROR_CODE,
        ].includes(error?.code)) {
          try {
            await showRouterAlert(error.message, "error")
          } catch {
            // A failed toast must not hide the routing error itself.
          }
        }
        throw error
      }
      if (!output.message?.model || !output.message?.agent) return
      if (
        output.message.model.providerID === "claude-agent"
        && output.parts.some((part) => part.type === "agent")
      ) {
        output.parts = await control.resolveAgentMentions({
          sessionID: input.sessionID,
          parts: output.parts,
        })
      }
      const messageID = input.messageID ?? output.message.id
      const effective = await control.applyTurn({
        sessionID: input.sessionID,
        messageID,
        agent: output.message.agent,
        providerID: output.message.model.providerID,
        modelID: output.message.model.modelID,
      })
      const described = await control.describe(input.sessionID, routingAgent)
      const state = {
        mode: described.mode,
        profile: effective.policy.profile,
        providerID: output.message.model.providerID,
        modelID: output.message.model.modelID,
      }
      try {
        if (announcer.changed(input.sessionID, state)) {
          await showRouterToast({
            mode: state.mode,
            profile: state.profile,
            target: { providerID: state.providerID, modelID: state.modelID },
          })
        }
      } catch {
        // Visual feedback must never block the selected worker.
      }
    },
    event: async (input) => {
      await control.event(input.event)
      if (input.event?.type !== "session.compacted") return
      const sessionID = input.event.properties?.sessionID ?? input.event.data?.sessionID
      if (typeof sessionID !== "string" || !sessionID) return
      try {
        await checkpoints.afterCompaction({ sessionID })
      } catch {
        await checkpointNotice({
          message: "Local Claude checkpoint binding was deferred; the next message will try to validate it again.",
        })
      }
    },
    "experimental.session.compacting": async (input) => {
      await checkpoints.beforeCompaction({ sessionID: input.sessionID })
    },
    "chat.params": async (input, output) => {
      await control.chatParams(input, output)
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
