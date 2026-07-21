import { tool } from "@opencode-ai/plugin"
import {
  enforceMinimumRoute,
  executionPolicy,
  routeTarget,
  selectClaudeEffort,
} from "../lib/routing_policy.mjs"
import { requireRouterRequest } from "../lib/prompt_guard.mjs"
import { parseClassifierResult } from "../lib/route_contract.mjs"

const ROUTER_PATH = "__LLM_ROUTER_PATH__"
const ROUTER_TIMEOUT_MS = 120_000

export default tool({
  description: "Classify one workflow stage with the local llm-router and return the exact OpenCode subagent or tool that must handle it.",
  args: {
    stage: tool.schema.enum(["request", "plan", "execute", "review"]).describe("Current workflow stage"),
  },
  async execute(args, context) {
    if (args.stage === "review") {
      const route = "codex-reviewer"
      return JSON.stringify({
        stage: args.stage,
        route,
        ...routeTarget(route),
        ...executionPolicy(route),
      })
    }

    const request = requireRouterRequest(context.sessionID)

    const child = Bun.spawn([ROUTER_PATH, "--classify", "--json", "--", request], {
      cwd: context.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    let aborted = false
    let timedOut = false
    const abortHandler = () => {
      aborted = true
      child.kill()
    }
    context.abort.addEventListener("abort", abortHandler, { once: true })
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
      context.abort.removeEventListener("abort", abortHandler)
    }

    if (aborted) throw new Error("llm-router was aborted by the OpenCode session")
    if (timedOut) throw new Error(`llm-router timed out after ${ROUTER_TIMEOUT_MS}ms`)

    if (exitCode !== 0) {
      throw new Error(`llm-router failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }

    const classified = parseClassifierResult(stdout.trim())
    const route = enforceMinimumRoute(classified.route, args.stage, request)
    const target = routeTarget(route)
    const effort = route === "claude"
      ? { effort: selectClaudeEffort(args.stage, request) }
      : {}
    return JSON.stringify({
      stage: args.stage,
      route,
      classified_route: classified.route,
      intent: classified.intent,
      ...target,
      ...effort,
      ...executionPolicy(route),
    })
  },
})
