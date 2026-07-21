import { tool } from "@opencode-ai/plugin"

const OPENCODE_PATH = "__OPENCODE_PATH__"
const TIMEOUT_MS = 30 * 60 * 1000

export default tool({
  description: "Run a delegated stage in an isolated OpenCode worker using its fixed model and return the worker's final response to the central router.",
  args: {
    agent: tool.schema.enum(["minimax", "glm", "codex", "codex-reviewer"]).describe("Worker selected by llm_route"),
    request: tool.schema.string().min(1).describe("Complete delegated request with all context and constraints needed by the worker"),
  },
  async execute(args, context) {
    const child = Bun.spawn([
      OPENCODE_PATH,
      "run",
      "--pure",
      "--auto",
      "--agent",
      args.agent,
      "--format",
      "json",
      args.request,
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

    if (aborted) throw new Error(`OpenCode worker ${args.agent} was aborted by the parent session`)
    if (timedOut) throw new Error(`OpenCode worker ${args.agent} timed out after 30 minutes`)
    if (exitCode !== 0) {
      throw new Error(`OpenCode worker ${args.agent} failed with exit ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }

    const textParts: string[] = []
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        if (event.type === "text" && typeof event.part?.text === "string") {
          textParts.push(event.part.text)
        }
      } catch {
        // Ignore non-JSON progress output and keep parsing subsequent events.
      }
    }

    const result = textParts.join("").trim()
    if (!result) {
      throw new Error(`OpenCode worker ${args.agent} completed without a final text response: ${stderr.trim() || stdout.trim()}`)
    }
    return result
  },
})
