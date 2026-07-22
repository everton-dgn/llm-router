import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"

export const CLAUDE_MODEL = "claude-opus-4-8"
export const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000
export const CLAUDE_SYSTEM_PROMPT = [
  "Complete the current user request using only the text supplied on stdin for this invocation.",
  "You have no implicit Claude Code session state. Treat only the sanitized transcript supplied on stdin as conversation context.",
  "You have no tools and no access to files, commands, browsers, MCP servers, skills, plugins, agents, or external context.",
  "Do not claim to have inspected the workspace. Preserve the requested language and output format. Return only the answer for the user.",
].join("\n\n")

const STDERR_LIMIT_BYTES = 64 * 1024
const FORCE_KILL_DELAY_MS = 1_000

const ALLOWED_ENVIRONMENT_NAMES = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LANGUAGE",
  "LOCALAPPDATA",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
])

function isAllowedEnvironmentName(name) {
  const normalized = name.toUpperCase()
  return ALLOWED_ENVIRONMENT_NAMES.has(normalized)
    || normalized.startsWith("ANTHROPIC_")
    || normalized.startsWith("CLAUDE_")
    || normalized.startsWith("LC_")
}

function buildClaudeEnvironment(parentEnv) {
  const env = {}
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!isAllowedEnvironmentName(name) || typeof value !== "string") continue
    if (value.trimStart().startsWith("()")) continue
    env[name] = value
  }
  return env
}

export function buildClaudeCliInvocation({
  cwd,
  model = CLAUDE_MODEL,
  claudePath,
  parentEnv = process.env,
}) {
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new Error("Claude working directory must be a non-empty string")
  }
  if (typeof claudePath !== "string" || !path.isAbsolute(claudePath)) {
    throw new Error("Claude executable path must be absolute")
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Claude model must be a non-empty string")
  }
  if (!parentEnv || typeof parentEnv !== "object" || Array.isArray(parentEnv)) {
    throw new Error("Claude parent environment must be an object")
  }
  return {
    command: claudePath,
    args: [
      "-p",
      "--input-format",
      "text",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model",
      model,
      "--permission-mode",
      "dontAsk",
      "--safe-mode",
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-chrome",
      "--no-session-persistence",
      "--system-prompt",
      CLAUDE_SYSTEM_PROMPT,
    ],
    options: {
      cwd,
      env: buildClaudeEnvironment(parentEnv),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  }
}

function invalidJsonError(lineNumber, cause) {
  return new Error(`Claude CLI emitted invalid stream JSON on line ${lineNumber}`, { cause })
}

export async function* parseClaudeJsonLines(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
    throw new Error("Claude CLI stdout is not readable")
  }

  const decoder = new TextDecoder("utf-8", { fatal: true })
  let buffered = ""
  let lineNumber = 0

  const parseLine = (line) => {
    lineNumber += 1
    const trimmed = line.trim()
    if (!trimmed) return undefined
    try {
      return JSON.parse(trimmed)
    } catch (error) {
      throw invalidJsonError(lineNumber, error)
    }
  }

  try {
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true })
      while (true) {
        const newline = buffered.indexOf("\n")
        if (newline === -1) break
        const message = parseLine(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        if (message !== undefined) yield message
      }
    }
    buffered += decoder.decode()
  } catch (error) {
    if (error?.message?.startsWith("Claude CLI emitted invalid stream JSON")) throw error
    throw new Error("Claude CLI stdout could not be decoded as UTF-8 JSONL", { cause: error })
  }

  if (buffered) {
    const message = parseLine(buffered)
    if (message !== undefined) yield message
  }
}

async function collectClaudeMessages(messages, { onMessage } = {}) {
  if (onMessage !== undefined && typeof onMessage !== "function") {
    throw new Error("Claude message callback must be a function")
  }
  let finalResult
  for await (const message of messages) {
    if (message?.type === "system" && message.subtype === "init") {
      const tools = Array.isArray(message.tools) ? message.tools : []
      const mcpServers = Array.isArray(message.mcp_servers)
        ? message.mcp_servers
        : Object.keys(message.mcp_servers ?? {})
      if (tools.length > 0 || mcpServers.length > 0) {
        throw new Error("Claude CLI violated the tool-free contract during initialization")
      }
    }
    await onMessage?.(message)
    if (message?.type === "result") finalResult = message
  }
  return finalResult
}

function validateClaudeResult(finalResult) {
  if (!finalResult) {
    throw new Error("Claude CLI completed without a result message")
  }
  if (finalResult.subtype !== "success") {
    const details = Array.isArray(finalResult.errors)
      ? finalResult.errors.join("; ")
      : "no error details"
    throw new Error(`Claude CLI failed with ${finalResult.subtype}: ${details}`)
  }
  if (finalResult.is_error) {
    throw new Error(`Claude CLI returned an error result: ${finalResult.result || "no error details"}`)
  }
  if (typeof finalResult.result !== "string" || !finalResult.result.trim()) {
    throw new Error("Claude Opus returned an empty response")
  }

  return {
    ...finalResult,
    uuid: finalResult.uuid ?? finalResult.session_id,
    result: finalResult.result.trim(),
  }
}

export async function consumeClaudeResult(messages, options) {
  return validateClaudeResult(await collectClaudeMessages(messages, options))
}

async function collectStderr(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return ""
  const chunks = []
  let collected = 0
  let truncated = false

  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk)
    const remaining = STDERR_LIMIT_BYTES - collected
    if (remaining > 0) {
      const selected = bytes.subarray(0, remaining)
      chunks.push(selected)
      collected += selected.byteLength
    }
    if (bytes.byteLength > remaining) truncated = true
  }

  const text = Buffer.concat(chunks).toString("utf8").trim()
  return truncated ? `${text}\n[stderr truncated]`.trim() : text
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      reject(new Error(`Claude CLI failed to start: ${error.message}`, { cause: error }))
    }
    child.once("error", onError)
    child.once("close", (code, signal) => {
      child.removeListener("error", onError)
      resolve({ code, signal })
    })
  })
}

function exitError({ code, signal }, stderr) {
  const status = code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`
  const details = stderr || "no stderr output"
  return new Error(`Claude CLI exited with ${status}: ${details}`)
}

export async function runClaudeCli({
  request,
  cwd,
  model = CLAUDE_MODEL,
  claudePath,
  parentSignal,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  forceKillDelayMs = FORCE_KILL_DELAY_MS,
  onMessage,
  spawnProcess = spawn,
}) {
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Claude request must be a non-empty string")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Claude timeout must be a positive number")
  }
  if (!Number.isFinite(forceKillDelayMs) || forceKillDelayMs <= 0) {
    throw new Error("Claude force-kill delay must be a positive number")
  }
  if (typeof spawnProcess !== "function") {
    throw new Error("Claude process factory must be a function")
  }
  if (parentSignal?.aborted) {
    throw new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal.reason })
  }

  const workspace = await realpath(cwd)
  if (parentSignal?.aborted) {
    throw new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal.reason })
  }
  const invocation = buildClaudeCliInvocation({
    cwd: workspace,
    model,
    claudePath,
  })

  let child
  try {
    child = spawnProcess(invocation.command, invocation.args, invocation.options)
  } catch (error) {
    throw new Error(`Claude CLI failed to start: ${error.message}`, { cause: error })
  }
  if (!child?.stdin || !child.stdout || !child.stderr || typeof child.kill !== "function") {
    try {
      child?.kill?.("SIGTERM")
    } catch {}
    throw new Error("Claude CLI process did not expose piped stdio")
  }

  let abortSource
  let timeout
  let forceKillTimer
  let interruptReject
  const terminate = () => {
    if (!child || child.exitCode !== null || child.signalCode) return
    try {
      child.kill("SIGTERM")
    } catch {}
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && !child.signalCode) {
        try {
          child.kill("SIGKILL")
        } catch {}
      }
    }, forceKillDelayMs)
    forceKillTimer.unref?.()
  }
  const interrupt = (source, error) => {
    if (abortSource) return
    abortSource = source
    terminate()
    interruptReject?.(error)
  }
  const abortFromParent = () => interrupt(
    "parent",
    new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal?.reason }),
  )
  const abortFromTimeout = () => interrupt(
    "timeout",
    new Error(`Claude Opus timed out after ${timeoutMs}ms`),
  )
  const interrupted = new Promise((resolve, reject) => {
    interruptReject = reject
  })

  child.stdin.on("error", () => {
    // Exit code and stderr provide the authoritative process failure.
  })

  try {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true })
    if (parentSignal?.aborted) abortFromParent()
    timeout = setTimeout(abortFromTimeout, timeoutMs)
    child.stdin.end(request, "utf8")

    const execution = Promise.all([
      collectClaudeMessages(parseClaudeJsonLines(child.stdout), { onMessage }),
      waitForExit(child),
      collectStderr(child.stderr),
    ])
    const [finalResult, exit, stderr] = await Promise.race([execution, interrupted])

    if (exit.code !== 0) throw exitError(exit, stderr)
    return validateClaudeResult(finalResult)
  } catch (error) {
    if (!abortSource) terminate()
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    if (forceKillTimer && (child.exitCode !== null || child.signalCode)) clearTimeout(forceKillTimer)
    parentSignal?.removeEventListener("abort", abortFromParent)
  }
}
