import { query } from "@anthropic-ai/claude-agent-sdk"
import { tool } from "@opencode-ai/plugin"
import { runClaudeAgentQuery } from "../lib/claude_agent.mjs"

export default tool({
  description: "Delegate read-only planning, architecture, product ideation, open-ended reasoning, or complex creative writing to Claude Opus 4.8 using the stage and effort selected by llm_route.",
  args: {
    request: tool.schema.string().min(1).describe("Complete delegated request, including relevant context and constraints"),
    stage: tool.schema.enum(["request", "plan"]).describe("Read-only workflow stage selected by llm_route"),
    effort: tool.schema.enum(["xhigh", "max"]).describe("Reasoning effort returned by llm_route for this task"),
  },
  async execute(args, context) {
    return runClaudeAgentQuery({
      query,
      request: args.request,
      stage: args.stage,
      effort: args.effort,
      cwd: context.directory,
      parentSignal: context.abort,
    })
  },
})
