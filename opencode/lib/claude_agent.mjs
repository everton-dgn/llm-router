import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

export const CLAUDE_MODEL = "claude-opus-4-8"
export const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000

export const READ_ONLY_TOOLS = Object.freeze([
  "Read",
  "Glob",
  "Grep",
])

export const DISALLOWED_TOOLS = Object.freeze([
  "Write",
  "Edit",
  "NotebookEdit",
  "Bash",
  "Task",
  "Agent",
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "Skill",
])

const VALID_STAGES = new Set(["request", "plan"])
const READ_ONLY_TOOL_SET = new Set(READ_ONLY_TOOLS)
const execFileAsync = promisify(execFile)
const SENSITIVE_SUFFIXES = new Set([".pem", ".key", ".p12", ".pfx", ".crt"])
const SENSITIVE_NAMES = new Set([
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
])

export function isSensitiveClaudePath(value) {
  const normalized = String(value).replaceAll("\\", "/").toLowerCase()
  const parts = normalized.split("/").filter(Boolean)
  const name = parts.at(-1) ?? ""
  if (parts.includes(".git") || name === ".env" || name.startsWith(".env.")) return true
  if (SENSITIVE_SUFFIXES.has(path.extname(name)) || SENSITIVE_NAMES.has(name)) return true
  if (name.startsWith("service_account") && name.endsWith(".json")) return true
  const tail = parts.slice(-2).join("/")
  return tail === ".ssh/config" || tail === ".aws/credentials" || tail === ".kube/config"
}

function isWithinWorkspace(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

async function resolveWorkspacePath(workspaceRoot, value) {
  const root = await realpath(workspaceRoot)
  const candidate = path.resolve(root, value || ".")
  if (!isWithinWorkspace(root, candidate)) return null

  let probe = candidate
  while (true) {
    try {
      const resolved = await realpath(probe)
      if (!isWithinWorkspace(root, resolved)) return null
      const resolvedRelative = path.relative(root, resolved)
      return isSensitiveClaudePath(resolvedRelative) ? null : candidate
    } catch {
      const parent = path.dirname(probe)
      if (parent === probe) return null
      probe = parent
    }
  }
}

async function containsSensitiveSearchPath(workspaceRoot, target) {
  const relative = path.relative(workspaceRoot, target) || "."
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", relative],
      { cwd: workspaceRoot, encoding: null, maxBuffer: 10 * 1024 * 1024 },
    )
    return Buffer.from(stdout).toString("utf8").split("\0").some(isSensitiveClaudePath)
  } catch {
    return true
  }
}

export async function enforceClaudeReadOnlyTool(input, workspaceRoot) {
  const toolName = input?.tool_name
  let allowed = READ_ONLY_TOOL_SET.has(toolName)
  let reason = `Tool ${toolName ?? "unknown"} is not allowed in read-only Claude delegation`

  if (allowed && ["Read", "Glob", "Grep"].includes(toolName)) {
    const rawPath = input.tool_input?.file_path ?? input.tool_input?.path ?? "."
    const resolved = await resolveWorkspacePath(workspaceRoot, rawPath)
    allowed = resolved !== null && !isSensitiveClaudePath(rawPath)
    if (allowed && toolName === "Glob") {
      const pattern = String(input.tool_input?.pattern ?? "")
      allowed = !path.isAbsolute(pattern)
        && !pattern.split(/[\\/]/).includes("..")
        && !isSensitiveClaudePath(pattern)
    }
    if (allowed && toolName === "Grep") {
      allowed = !isSensitiveClaudePath(input.tool_input?.glob ?? "")
        && !(await containsSensitiveSearchPath(await realpath(workspaceRoot), resolved))
    }
    if (!allowed) reason = `${toolName} path is outside the workspace or may access a sensitive file`
  }

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: allowed ? "allow" : "deny",
      ...(allowed
        ? {}
        : { permissionDecisionReason: reason }),
    },
  }
}

export function mapClaudeEffort(effort) {
  if (effort === "xhigh") return "xhigh"
  if (effort === "max") return "max"
  throw new Error(`Unsupported Claude effort: ${effort}`)
}

export function buildClaudeQueryOptions({ stage, effort, cwd, abortController }) {
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`Unsupported Claude stage: ${stage}`)
  }
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Claude working directory must be a non-empty string")
  }

  return {
    abortController,
    cwd,
    model: CLAUDE_MODEL,
    effort: mapClaudeEffort(effort),
    tools: [...READ_ONLY_TOOLS],
    allowedTools: [...READ_ONLY_TOOLS],
    disallowedTools: [...DISALLOWED_TOOLS],
    hooks: {
      PreToolUse: [{
        hooks: [(input) => enforceClaudeReadOnlyTool(input, cwd)],
      }],
    },
    permissionMode: stage === "plan" ? "plan" : "dontAsk",
    persistSession: false,
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "Complete only the delegated task. You may inspect non-sensitive files inside the working directory, but do not access external paths, modify files, use the network, execute commands, or delegate to another agent. Preserve the requested language and output format.",
    },
  }
}

export async function consumeClaudeResult(messages) {
  let finalResult

  for await (const message of messages) {
    if (message?.type === "result") finalResult = message
  }

  if (!finalResult) {
    throw new Error("Claude Agent SDK completed without a result message")
  }
  if (finalResult.subtype !== "success") {
    const details = Array.isArray(finalResult.errors)
      ? finalResult.errors.join("; ")
      : "no error details"
    throw new Error(`Claude Agent SDK failed with ${finalResult.subtype}: ${details}`)
  }
  if (finalResult.is_error) {
    throw new Error(`Claude Agent SDK returned an error result: ${finalResult.result || "no error details"}`)
  }
  if (typeof finalResult.result !== "string" || !finalResult.result.trim()) {
    throw new Error("Claude Opus returned an empty response")
  }

  return finalResult.result.trim()
}

export async function runClaudeAgentQuery({
  query,
  request,
  stage,
  effort,
  cwd,
  parentSignal,
  timeoutMs = CLAUDE_TIMEOUT_MS,
}) {
  if (typeof query !== "function") throw new Error("Claude query factory is required")
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Claude request must be a non-empty string")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Claude timeout must be a positive number")
  }

  const abortController = new AbortController()
  let abortSource = null
  let sdkQuery
  let failure

  const abortFromParent = () => {
    if (abortController.signal.aborted) return
    abortSource = "parent"
    abortController.abort(parentSignal?.reason)
  }
  const abortFromTimeout = () => {
    if (abortController.signal.aborted) return
    abortSource = "timeout"
    abortController.abort(new Error(`Claude Opus timed out after ${timeoutMs}ms`))
  }

  if (parentSignal?.aborted) abortFromParent()
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true })

  const timeout = setTimeout(abortFromTimeout, timeoutMs)

  try {
    if (abortSource === "parent") {
      throw new Error("Claude Opus was aborted by the OpenCode session")
    }

    const options = buildClaudeQueryOptions({ stage, effort, cwd, abortController })
    sdkQuery = query({ prompt: request, options })
    const result = await consumeClaudeResult(sdkQuery)

    if (abortSource === "parent") {
      throw new Error("Claude Opus was aborted by the OpenCode session")
    }
    if (abortSource === "timeout") {
      throw new Error(`Claude Opus timed out after ${timeoutMs}ms`)
    }

    return result
  } catch (error) {
    if (abortSource === "parent") {
      failure = new Error("Claude Opus was aborted by the OpenCode session", { cause: error })
    } else if (abortSource === "timeout") {
      failure = new Error(`Claude Opus timed out after ${timeoutMs}ms`, { cause: error })
    } else {
      failure = error
    }
    throw failure
  } finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener("abort", abortFromParent)
    if (sdkQuery && typeof sdkQuery.close === "function") {
      try {
        await sdkQuery.close()
      } catch (closeError) {
        if (!failure) throw closeError
      }
    }
  }
}
