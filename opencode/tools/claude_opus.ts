import { tool } from "@opencode-ai/plugin"

const CLAUDE_PATH = "__CLAUDE_PATH__"
const TIMEOUT_MS = 15 * 60 * 1000

export default tool({
  description: "Delegate planning, architecture, product ideation, open-ended reasoning, or complex creative writing to Claude Opus 4.8 using the effort selected by llm_route.",
  args: {
    request: tool.schema.string().min(1).describe("Complete delegated request, including relevant context and constraints"),
    effort: tool.schema.enum(["xhigh", "max"]).describe("Reasoning effort returned by llm_route for this task"),
  },
  async execute(args, context) {
    const child = Bun.spawn([
      CLAUDE_PATH,
      "--print",
      args.request,
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--model",
      "claude-opus-4-8",
      "--effort",
      args.effort,
      "--append-system-prompt",
      "Complete only the delegated task. You may inspect the working directory, but do not modify files or delegate to another agent. Preserve the requested language and output format.",
      "--tools",
      "Read,Glob,Grep,WebFetch,WebSearch",
    ], {
      cwd: context.directory,
      stdout: "pipe",
      stderr: "pipe",
    })

    let timedOut = false
    let aborted = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, TIMEOUT_MS)
    const abortHandler = () => {
      aborted = true
      child.kill()
    }
    context.abort.addEventListener("abort", abortHandler, { once: true })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timeout)
    context.abort.removeEventListener("abort", abortHandler)

    if (aborted) throw new Error("Claude Opus was aborted by the OpenCode session")
    if (timedOut) throw new Error("Claude Opus timed out after 15 minutes")
    if (exitCode !== 0) {
      throw new Error(`Claude Opus failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }

    const result = stdout.trim()
    if (!result) throw new Error("Claude Opus returned an empty response")
    return result
  },
})
