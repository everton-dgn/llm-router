import { realpath } from "node:fs/promises"
import path from "node:path"

export const CLAUDE_MODEL = "claude-opus-4-8"
export const CLAUDE_TIMEOUT_MS = 15 * 60 * 1000
export const CLAUDE_PERMISSION_TIMEOUT_MS = 30 * 1000
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

const PERMISSION_BEHAVIORS = new Set(["allow", "ask", "deny"])
const PERMISSION_MODES = new Set(["acceptEdits", "auto", "default", "dontAsk", "plan"])

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

export function createClaudeMessageStream(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Claude request must contain at least one SDKUserMessage")
  }
  for (const [index, message] of messages.entries()) {
    if (
      message?.type !== "user"
      || message.parent_tool_use_id !== null
      || !message.message
      || !["assistant", "user"].includes(message.message.role)
      || !Array.isArray(message.message.content)
      || message.message.content.length === 0
      || (message.shouldQuery !== undefined && typeof message.shouldQuery !== "boolean")
    ) {
      throw new Error("Claude request contains an invalid SDKUserMessage")
    }
    if (index < messages.length - 1 && message.shouldQuery !== false) {
      throw new Error("Claude historical SDKUserMessage must set shouldQuery to false")
    }
    if (
      index === messages.length - 1
      && (message.message.role !== "user" || message.shouldQuery === false)
    ) {
      throw new Error("Claude final SDKUserMessage must query as the user")
    }
  }
  const snapshot = structuredClone(messages)
  return Object.freeze({
    async *[Symbol.asyncIterator]() {
      for (const message of snapshot) yield structuredClone(message)
    },
  })
}

function normalizePermissionProfile(permissionProfile) {
  if (permissionProfile === undefined) {
    return { configured: false, default: "ask", mode: "auto", tools: {} }
  }
  if (!permissionProfile || typeof permissionProfile !== "object" || Array.isArray(permissionProfile)) {
    throw new Error("Claude permissionProfile must be an object")
  }
  const mode = permissionProfile.mode ?? "default"
  if (!PERMISSION_MODES.has(mode)) {
    throw new Error(`Claude permissionProfile mode is unsupported: ${String(mode)}`)
  }
  const defaultBehavior = permissionProfile.default ?? "ask"
  if (!PERMISSION_BEHAVIORS.has(defaultBehavior)) {
    throw new Error(`Claude permissionProfile default is invalid: ${String(defaultBehavior)}`)
  }
  const sourceTools = permissionProfile.tools ?? {}
  if (!sourceTools || typeof sourceTools !== "object" || Array.isArray(sourceTools)) {
    throw new Error("Claude permissionProfile tools must be an object")
  }
  const tools = Object.create(null)
  for (const [toolName, behavior] of Object.entries(sourceTools)) {
    if (!toolName.trim() || !PERMISSION_BEHAVIORS.has(behavior)) {
      throw new Error(`Claude permissionProfile has an invalid tool rule: ${toolName}`)
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(toolName)) {
      throw new Error("Claude permissionProfile tools must use exact tool names")
    }
    tools[toolName] = behavior
  }
  return { configured: true, default: defaultBehavior, mode, tools }
}

function permissionDenial(message, toolUseID) {
  return {
    behavior: "deny",
    message,
    ...(typeof toolUseID === "string" && toolUseID ? { toolUseID } : {}),
  }
}

function normalizePermissionCallbackResult(result, toolName, toolUseID) {
  if (result === "allow") return { behavior: "allow", ...(toolUseID ? { toolUseID } : {}) }
  if (result === "deny") {
    return permissionDenial(`Claude tool ${toolName} was denied by the host permission callback`, toolUseID)
  }
  if (!result || typeof result !== "object" || !["allow", "deny"].includes(result.behavior)) {
    return permissionDenial(`Claude tool ${toolName} approval failed closed`, toolUseID)
  }
  if (result.behavior === "deny") {
    return {
      ...result,
      message: typeof result.message === "string" && result.message.trim()
        ? result.message
        : `Claude tool ${toolName} was denied by the host permission callback`,
      ...(toolUseID ? { toolUseID } : {}),
    }
  }
  return { ...result, ...(toolUseID ? { toolUseID } : {}) }
}

function requestPermission({
  permissionCallback,
  permissionTimeoutMs,
  toolName,
  input,
  options,
}) {
  const toolUseID = options?.toolUseID
  if (options?.signal?.aborted) {
    return Promise.resolve(permissionDenial(
      `Claude tool ${toolName} approval was cancelled`,
      toolUseID,
    ))
  }
  if (permissionCallback === undefined) {
    return Promise.resolve(permissionDenial(
      `Claude tool ${toolName} requires approval, but no host permission callback is configured`,
      toolUseID,
    ))
  }

  return new Promise((resolve) => {
    const callbackController = new AbortController()
    let settled = false
    let timeout
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      options?.signal?.removeEventListener("abort", cancel)
    }
    const finish = (result, abortReason) => {
      if (settled) return
      settled = true
      if (abortReason !== undefined) callbackController.abort(abortReason)
      cleanup()
      resolve(result)
    }
    const cancel = () => finish(
      permissionDenial(`Claude tool ${toolName} approval was cancelled`, toolUseID),
      options?.signal?.reason ?? new Error(`Claude tool ${toolName} approval was cancelled`),
    )

    options?.signal?.addEventListener("abort", cancel, { once: true })
    timeout = setTimeout(() => finish(
      permissionDenial(
        `Claude tool ${toolName} approval timed out after ${permissionTimeoutMs}ms`,
        toolUseID,
      ),
      new Error(`Claude tool ${toolName} approval timed out`),
    ), permissionTimeoutMs)

    Promise.resolve()
      .then(() => permissionCallback(toolName, input, {
        ...options,
        signal: callbackController.signal,
      }))
      .then(
        (result) => finish(normalizePermissionCallbackResult(result, toolName, toolUseID)),
        () => finish(permissionDenial(`Claude tool ${toolName} approval failed closed`, toolUseID)),
      )
  })
}

export function prepareClaudePermissionPolicy({
  permissionProfile,
  permissionCallback,
  permissionTimeoutMs = CLAUDE_PERMISSION_TIMEOUT_MS,
} = {}) {
  if (permissionCallback !== undefined && typeof permissionCallback !== "function") {
    throw new Error("Claude permissionCallback must be a function")
  }
  let profile = normalizePermissionProfile(permissionProfile)
  if (!profile.configured && permissionCallback !== undefined) {
    profile = { configured: true, default: "ask", mode: "default", tools: {} }
  }
  if (!Number.isInteger(permissionTimeoutMs) || permissionTimeoutMs <= 0) {
    throw new Error("Claude permissionTimeoutMs must be a positive integer")
  }
  const allowedTools = Object.keys(profile.tools)
    .filter((toolName) => profile.tools[toolName] === "allow")
    .sort()
  const disallowedTools = Object.keys(profile.tools)
    .filter((toolName) => profile.tools[toolName] === "deny")
    .sort()
  const promptedTools = Object.keys(profile.tools)
    .filter((toolName) => profile.tools[toolName] === "ask")
    .sort()
  if (profile.configured && profile.mode === "dontAsk") {
    const defaultAllow = profile.default === "allow" ? "cannot enforce default allow; " : ""
    throw new Error(`Claude permissionProfile ${defaultAllow}dontAsk cannot enforce host permission profiles`)
  }
  if (
    profile.configured
    && profile.default === "allow"
    && !["acceptEdits", "default"].includes(profile.mode)
  ) {
    throw new Error(`Claude permissionProfile mode ${profile.mode} cannot enforce default allow`)
  }
  const settings = profile.configured
    ? {
        permissions: {
          allow: allowedTools,
          ask: profile.default === "allow" ? promptedTools : ["*"],
          defaultMode: profile.mode,
          deny: disallowedTools,
        },
      }
    : undefined

  return {
    canUseTool(toolName, input, options) {
      const behavior = profile.tools[toolName] ?? profile.default
      if (options?.signal?.aborted) {
        return Promise.resolve(permissionDenial(
          `Claude tool ${toolName} approval was cancelled`,
          options?.toolUseID,
        ))
      }
      if (behavior === "allow") {
        return Promise.resolve({
          behavior: "allow",
          ...(options?.toolUseID ? { toolUseID: options.toolUseID } : {}),
        })
      }
      if (behavior === "deny") {
        return Promise.resolve(permissionDenial(
          `Claude tool ${toolName} is denied by the host permission profile`,
          options?.toolUseID,
        ))
      }
      return requestPermission({
        permissionCallback,
        permissionTimeoutMs,
        toolName,
        input,
        options,
      })
    },
    disallowedTools,
    permissionMode: profile.mode,
    ...(profile.configured ? { sandbox: { autoAllowBashIfSandboxed: false } } : {}),
    ...(settings ? { settings } : {}),
  }
}

export function buildClaudeAgentOptions({
  abortController,
  cwd,
  model = CLAUDE_MODEL,
  claudePath,
  parentEnv = process.env,
  permissionCallback,
  permissionProfile,
  permissionTimeoutMs,
  maxTurns,
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
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns <= 0)) {
    throw new Error("Claude maxTurns must be a positive integer")
  }
  const permissionPolicy = prepareClaudePermissionPolicy({
    permissionCallback,
    permissionProfile,
    permissionTimeoutMs,
  })
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
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    model,
    pathToClaudeCodeExecutable: claudePath,
    ...permissionPolicy,
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
  permissionCallback,
  permissionProfile,
  permissionTimeoutMs,
  maxTurns,
}) {
  if (typeof query !== "function") throw new Error("Claude Agent SDK query factory is required")
  if (!request || typeof request[Symbol.asyncIterator] !== "function") {
    throw new Error("Claude request must be an AsyncIterable of SDKUserMessage")
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
    permissionCallback,
    permissionProfile,
    permissionTimeoutMs,
    maxTurns,
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
