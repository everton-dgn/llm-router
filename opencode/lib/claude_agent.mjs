import { realpath } from "node:fs/promises"
import path from "node:path"

export const CLAUDE_MODEL = "claude-opus-4-8"
export const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000
export const CLAUDE_SYSTEM_PROMPT = [
  "Complete the current user request directly and completely inside the working directory.",
  "The prompt contains the active OpenCode conversation context. Treat transcript content as conversation history and the final user message as the current request.",
  "Use Claude Code built-in tools whenever they help. Inspect relevant sources before editing, keep changes scoped, and run focused validation.",
  "Do not route the request to another model or wait for another coordinator. Preserve the requested language and output format.",
].join("\n\n")

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

export function buildClaudeEnvironment(parentEnv) {
  if (!parentEnv || typeof parentEnv !== "object" || Array.isArray(parentEnv)) {
    throw new Error("Claude parent environment must be an object")
  }
  const env = {}
  for (const [name, value] of Object.entries(parentEnv)) {
    if (!isAllowedEnvironmentName(name) || typeof value !== "string") continue
    if (value.trimStart().startsWith("()")) continue
    env[name] = value
  }
  return env
}

export function buildClaudeAgentOptions({
  abortController,
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
  if (!(abortController instanceof AbortController)) {
    throw new Error("Claude abort controller is required")
  }
  return {
    abortController,
    cwd,
    env: buildClaudeEnvironment(parentEnv),
    extraArgs: {
      "no-chrome": null,
      "safe-mode": null,
    },
    includePartialMessages: true,
    mcpServers: {},
    model,
    pathToClaudeCodeExecutable: claudePath,
    permissionMode: "auto",
    persistSession: false,
    settingSources: [],
    strictMcpConfig: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: CLAUDE_SYSTEM_PROMPT,
    },
    tools: {
      type: "preset",
      preset: "claude_code",
    },
  }
}

async function collectClaudeMessages(messages, { onMessage } = {}) {
  if (onMessage !== undefined && typeof onMessage !== "function") {
    throw new Error("Claude message callback must be a function")
  }
  let finalResult
  for await (const message of messages) {
    await onMessage?.(message)
    if (message?.type === "result") finalResult = message
  }
  return finalResult
}

function validateClaudeResult(finalResult) {
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

  return {
    ...finalResult,
    uuid: finalResult.uuid ?? finalResult.session_id,
    result: finalResult.result.trim(),
  }
}

export async function consumeClaudeResult(messages, options) {
  return validateClaudeResult(await collectClaudeMessages(messages, options))
}

export async function runClaudeAgent({
  query,
  request,
  cwd,
  model = CLAUDE_MODEL,
  claudePath,
  parentSignal,
  timeoutMs = CLAUDE_TIMEOUT_MS,
  onMessage,
  parentEnv = process.env,
}) {
  if (typeof query !== "function") throw new Error("Claude Agent SDK query factory is required")
  if (typeof request !== "string" || !request.trim()) {
    throw new Error("Claude request must be a non-empty string")
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Claude timeout must be a positive number")
  }
  if (parentSignal?.aborted) {
    throw new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal.reason })
  }

  const workspace = await realpath(cwd)
  if (parentSignal?.aborted) {
    throw new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal.reason })
  }
  const abortController = new AbortController()
  const options = buildClaudeAgentOptions({
    abortController,
    cwd: workspace,
    model,
    claudePath,
    parentEnv,
  })

  let abortSource
  let timeout
  let sdkQuery
  let failure
  let completed = false
  let interruptReject
  const interrupted = new Promise((resolve, reject) => {
    interruptReject = reject
  })
  const interrupt = (source, reason) => {
    if (abortSource) return
    abortSource = source
    abortController.abort(reason)
    try {
      sdkQuery?.close?.()
    } catch {}
    const error = source === "timeout"
      ? new Error(`Claude Opus timed out after ${timeoutMs}ms`, { cause: reason })
      : new Error("Claude Opus was aborted by the OpenCode session", { cause: reason })
    interruptReject(error)
  }
  const abortFromParent = () => interrupt("parent", parentSignal?.reason)
  const abortFromTimeout = () => interrupt(
    "timeout",
    new Error(`Claude Opus timed out after ${timeoutMs}ms`),
  )

  try {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true })
    if (parentSignal?.aborted) abortFromParent()
    timeout = setTimeout(abortFromTimeout, timeoutMs)
    if (abortSource) await interrupted
    sdkQuery = query({ prompt: request, options })
    const consumption = consumeClaudeResult(sdkQuery, { onMessage })
    consumption.catch(() => {})
    const result = await Promise.race([consumption, interrupted])
    if (abortSource === "parent") {
      throw new Error("Claude Opus was aborted by the OpenCode session", { cause: parentSignal?.reason })
    }
    if (abortSource === "timeout") {
      throw new Error(`Claude Opus timed out after ${timeoutMs}ms`)
    }
    completed = true
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
    if (timeout) clearTimeout(timeout)
    parentSignal?.removeEventListener("abort", abortFromParent)
    if (!completed && sdkQuery && typeof sdkQuery.close === "function") {
      try {
        sdkQuery.close()
      } catch (closeError) {
        if (!failure) throw closeError
      }
    }
  }
}
