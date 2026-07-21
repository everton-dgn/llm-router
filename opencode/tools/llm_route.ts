import { tool } from "@opencode-ai/plugin"
import { enforceMinimumRoute, selectClaudeEffort } from "../lib/routing_policy.mjs"

const ROUTER_PATH = "__LLM_ROUTER_PATH__"

const targets = {
  minimax: {
    kind: "delegate",
    target: "minimax",
    model: "minimax-coding-plan/MiniMax-M3",
  },
  glm: {
    kind: "delegate",
    target: "glm",
    model: "zai-coding-plan/glm-5.2",
  },
  claude: {
    kind: "tool",
    target: "claude_opus",
    model: "claude-opus-4-8",
  },
  codex: {
    kind: "delegate",
    target: "codex",
    model: "openai/gpt-5.6-sol",
  },
} as const

function stagePrompt(stage: "request" | "plan" | "execute" | "review", request: string) {
  if (stage === "plan") {
    return `Provide only a plan for this task. Do not implement it:\n${request}`
  }
  if (stage === "execute") {
    return `Implement or execute this task now:\n${request}`
  }
  if (stage === "review") {
    return `Review and audit the result of this task:\n${request}`
  }
  return `The user's actual request is:\n${request}`
}

export default tool({
  description: "Classify one workflow stage with the local llm-router and return the exact OpenCode subagent or tool that must handle it.",
  args: {
    request: tool.schema.string().min(1).describe("Self-contained request for this stage"),
    stage: tool.schema.enum(["request", "plan", "execute", "review"]).describe("Current workflow stage"),
  },
  async execute(args, context) {
    const child = Bun.spawn([ROUTER_PATH, stagePrompt(args.stage, args.request)], {
      cwd: context.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (exitCode !== 0) {
      throw new Error(`llm-router failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }

    const match = stdout.match(/^rota:\s+(minimax|glm|claude|codex)\s+->/m)
    if (!match) {
      throw new Error(`llm-router returned an unrecognized result: ${stdout.trim()}`)
    }

    const classifiedRoute = match[1] as keyof typeof targets
    const route = enforceMinimumRoute(classifiedRoute, args.stage, args.request) as keyof typeof targets
    const target = args.stage === "review"
      ? {
          kind: "delegate",
          target: "codex-reviewer",
          model: "openai/gpt-5.6-sol",
        }
      : targets[route]
    const effort = target.target === "claude_opus"
      ? { effort: selectClaudeEffort(args.stage, args.request) }
      : {}
    return JSON.stringify({
      stage: args.stage,
      route,
      ...target,
      ...effort,
    })
  },
})
