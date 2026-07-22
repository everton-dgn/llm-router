import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

import {
  createDirectModelHandoff,
  persistDirectModelSelection,
} from "../lib/direct_handoff.mjs"
import { createOpenCodeV2ClientFromLegacyTransport } from "../lib/opencode_transport.mjs"

const ROUTER_PATH = __LLM_ROUTER_PATH_LITERAL__
const ROUTER_TIMEOUT_MS = 120_000

export default async function llmRouterHandoff({ client, directory, worktree }) {
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
    persist: ({ input, target, previous }) => persistDirectModelSelection(
      v2Client,
      input.sessionID,
      target,
      previous,
    ),
    announce: async ({ route, target }) => {
      await client.tui.showToast({
        body: {
          title: "llm-router",
          message: `${route} -> ${target.providerID}/${target.modelID}`,
          variant: "info",
          duration: 3000,
        },
        query: { directory },
      })
    },
  })

  return {
    ...handoff,
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "claude-agent") return
      output.options.cwd = worktree || directory
    },
  }
}
