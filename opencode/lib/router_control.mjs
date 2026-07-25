import { randomUUID } from "node:crypto"

import { normalizeAttachmentMediaType } from "./route_manifest.mjs"
import { updateSessionMetadata } from "./session_metadata.mjs"

export const ROUTER_CONTROL_METADATA_KEY = "llm-router.control"
export const ROUTER_CONTROL_SCHEMA_VERSION = 1

const ROUTING_COMMANDS = Object.freeze({
  "router-auto": "auto",
  "router-adaptive": "adaptive",
  "router-pinned": "pinned",
})
const PROFILE_COMMANDS = Object.freeze({
  "router-native": "native",
  "router-restricted": "restricted",
  "router-full": "full",
})
const MODE_AGENTS = Object.freeze({
  auto: "router-auto",
  adaptive: "router-adaptive",
  pinned: "router-manual",
})
const LEGACY_AGENT_MODES = Object.freeze({
  "router-auto": "auto",
  "router-adaptive": "adaptive",
  "router-manual": "pinned",
})
const MAX_AGENT_MENTIONS = 4
const MAX_AGENT_RESULT_BYTES = 256 * 1024
const MAX_TRACKED_SESSIONS = 1024
const CONTROL_RESULT_PREFIX = "<llm-router-control-result>\n"

function replaceCommandResult(input, output, text) {
  const argumentsText = typeof input.arguments === "string"
    ? input.arguments.trim()
    : ""
  const invocation = `/${input.command}${argumentsText ? ` ${argumentsText}` : ""}`
  output.parts.splice(
    0,
    output.parts.length,
    { type: "text", text: invocation },
    { type: "text", text: `${CONTROL_RESULT_PREFIX}${text}`, synthetic: true },
  )
}

function responseData(response) {
  if (
    response
    && typeof response === "object"
    && Object.prototype.hasOwnProperty.call(response, "data")
  ) return response.data
  return response
}

function sessionMetadata(session) {
  const metadata = session?.metadata
  if (metadata === undefined) return {}
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("OpenCode session metadata is invalid for router control")
  }
  return metadata
}

function readControl(metadata, sessionID) {
  const stored = metadata?.[ROUTER_CONTROL_METADATA_KEY]
  if (stored === undefined || stored?.sessionID !== sessionID) {
    return {
      schemaVersion: ROUTER_CONTROL_SCHEMA_VERSION,
      sessionID,
      mode: "adaptive",
    }
  }
  if (
    !stored
    || typeof stored !== "object"
    || Array.isArray(stored)
    || stored.schemaVersion !== ROUTER_CONTROL_SCHEMA_VERSION
    || !Object.values(ROUTING_COMMANDS).includes(stored.mode)
    || (
      stored.profileOverride !== undefined
      && !Object.values(PROFILE_COMMANDS).includes(stored.profileOverride)
    )
  ) {
    throw new Error("OpenCode session has invalid llm-router control metadata")
  }
  return structuredClone(stored)
}

function exactSessionClient(sessionClient) {
  if (
    typeof sessionClient?.get !== "function"
    || typeof sessionClient?.update !== "function"
  ) throw new Error("OpenCode session get/update client is required for router control")
  return sessionClient
}

function permissionPreset(profile, resolved) {
  if (profile === "native") {
    return { ...resolved, profile, source: "session", selector: "explicit", permissions: [], limits: {} }
  }
  if (profile === "full") {
    return {
      ...resolved,
      profile,
      source: "session",
      selector: "explicit",
      permissions: [{ permission: "*", pattern: "*", action: "allow" }],
      limits: {},
    }
  }
  return resolved
}

function toolAction(toolName) {
  const aliases = {
    Agent: "task",
    Bash: "bash",
    Edit: "edit",
    Glob: "glob",
    Grep: "grep",
    NotebookEdit: "edit",
    Read: "read",
    Task: "task",
    WebFetch: "webfetch",
    WebSearch: "websearch",
    Write: "write",
  }
  return aliases[toolName] ?? String(toolName).toLowerCase()
}

function toolResources(toolName, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["*"]
  const preferred = toolName === "Bash"
    ? [input.command]
    : [input.file_path, input.path, input.pattern, input.query, input.url, input.prompt]
  const resources = preferred.filter((value) => typeof value === "string" && value.trim())
  return resources.length > 0 ? resources : ["*"]
}

function permissionResult(effect, message) {
  if (effect === "allow") return { behavior: "allow" }
  return {
    behavior: "deny",
    message: message || "Claude tool was denied by the OpenCode permission policy",
  }
}

function turnKey(sessionID, messageID) {
  return `${sessionID}\u0000${messageID}`
}

export function createRouterControlRuntime({
  directory,
  sessionClient,
  v2SessionClient,
  loadPolicy,
  resolvePolicy,
  uninstall,
  notify = async () => {},
  permissionTimeoutMs = 120_000,
}) {
  const sessions = exactSessionClient(sessionClient)
  if (typeof loadPolicy !== "function" || typeof resolvePolicy !== "function") {
    throw new TypeError("loadPolicy and resolvePolicy must be functions")
  }
  const turns = new Map()
  const activeTurns = new Map()
  const pendingPermissions = new Map()

  function activateTurn(sessionID, key, turn) {
    const previousKey = activeTurns.get(sessionID)
    if (previousKey && previousKey !== key) turns.delete(previousKey)
    turns.set(key, turn)
    activeTurns.delete(sessionID)
    activeTurns.set(sessionID, key)

    while (activeTurns.size > MAX_TRACKED_SESSIONS) {
      const oldestSessionID = activeTurns.keys().next().value
      const oldestKey = activeTurns.get(oldestSessionID)
      activeTurns.delete(oldestSessionID)
      if (oldestKey) turns.delete(oldestKey)
    }
  }

  async function getSession(sessionID) {
    const session = responseData(await sessions.get(
      { sessionID, directory },
      { throwOnError: true },
    ))
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw new Error("OpenCode returned invalid session data for router control")
    }
    return session
  }

  async function controlState(sessionID) {
    return readControl(sessionMetadata(await getSession(sessionID)), sessionID)
  }

  async function persistControl(sessionID, update) {
    const metadata = await updateSessionMetadata({
      sessionID,
      readMetadata: async () => sessionMetadata(await getSession(sessionID)),
      writeMetadata: async (currentSessionID, nextMetadata) => {
        await sessions.update(
          { sessionID: currentSessionID, directory, metadata: nextMetadata },
          { throwOnError: true },
        )
      },
      update: (metadata) => ({
        ...metadata,
        [ROUTER_CONTROL_METADATA_KEY]: update(readControl(metadata, sessionID)),
      }),
    })
    return metadata[ROUTER_CONTROL_METADATA_KEY]
  }

  async function resolveFor({ agent = "router", providerID, modelID, sessionID }) {
    const state = await controlState(sessionID)
    const policy = await loadPolicy()
    const resolved = resolvePolicy(policy, {
      agent,
      providerID,
      modelID,
      sessionOverride: state.profileOverride,
    })
    return {
      state,
      policy: state.profileOverride
        ? permissionPreset(state.profileOverride, resolved)
        : resolved,
    }
  }

  async function applyPermissions(sessionID, policy) {
    await sessions.update(
      { sessionID, directory, permission: policy.permissions },
      { throwOnError: true },
    )
  }

  function rememberTurn(sessionID, messageID, policy) {
    if (typeof messageID !== "string" || !messageID) {
      throw new Error("OpenCode message ID is required for execution limits")
    }
    const key = turnKey(sessionID, messageID)
    const existing = turns.get(key)
    const turn = existing?.policy === policy
      ? existing
      : { policy, steps: 0, toolCalls: 0 }
    activateTurn(sessionID, key, turn)
    return turn
  }

  async function applyTurn({ sessionID, messageID, agent, providerID, modelID }) {
    const effective = await resolveFor({ sessionID, agent, providerID, modelID })
    await applyPermissions(sessionID, effective.policy)
    rememberTurn(sessionID, messageID, effective.policy)
    return effective
  }

  async function commandBefore(input, output) {
    if (input.command === "router-uninstall") {
      if (typeof uninstall !== "function") {
        throw new Error("OpenCode uninstaller is unavailable")
      }
      const text = await uninstall(input.arguments ?? "")
      if (typeof text !== "string") {
        throw new TypeError("OpenCode uninstaller must return a text response")
      }
      replaceCommandResult(input, output, text)
      return
    }

    const isStatus = input.command === "router-status"
    const nextMode = ROUTING_COMMANDS[input.command]
    const nextProfile = PROFILE_COMMANDS[input.command]
    if (!isStatus && !nextMode && !nextProfile) return

    const state = isStatus
      ? await controlState(input.sessionID)
      : await persistControl(input.sessionID, (current) => ({
          ...current,
          ...(nextMode ? { mode: nextMode } : {}),
          ...(nextProfile ? { profileOverride: nextProfile } : {}),
        }))
    const effective = await resolveFor({ sessionID: input.sessionID })
    if (!isStatus) await applyPermissions(input.sessionID, effective.policy)
    const profile = state.profileOverride ?? effective.policy.profile
    replaceCommandResult(
      input,
      output,
      `${isStatus ? "Router status" : "Router control applied"}. mode: ${state.mode} | profile: ${profile}`,
    )
    await notify({ mode: state.mode, profile, control: true })
  }

  async function routingAgent(sessionID, agent) {
    if (agent !== "router") return agent
    const state = await controlState(sessionID)
    return MODE_AGENTS[state.mode]
  }

  async function sessionDepth(sessionID) {
    let depth = 0
    let current = await getSession(sessionID)
    const seen = new Set([sessionID])
    while (typeof current.parentID === "string" && current.parentID) {
      if (seen.has(current.parentID)) throw new Error("OpenCode session parent cycle detected")
      seen.add(current.parentID)
      depth += 1
      current = await getSession(current.parentID)
    }
    return depth
  }

  async function resolveAgentMentions({ sessionID, parts }) {
    const mentions = parts.filter((part) => part?.type === "agent")
    if (mentions.length === 0) return parts
    if (mentions.length > MAX_AGENT_MENTIONS) {
      throw new Error(`Claude supports at most ${MAX_AGENT_MENTIONS} explicit agent mentions per message`)
    }
    if (
      typeof sessions.create !== "function"
      || typeof v2SessionClient?.prompt !== "function"
      || typeof v2SessionClient?.wait !== "function"
      || typeof v2SessionClient?.context !== "function"
    ) throw new Error("OpenCode child-session API is unavailable for Claude agent mentions")

    const request = parts
      .filter((part) => part?.type === "text" && part.synthetic !== true)
      .map((part) => part.text)
      .join("")
    const files = parts
      .filter((part) => part?.type === "file" && typeof part.url === "string")
      .map((part) => {
        // The delegated session receives the same media type the router used to
        // pick a route, without transport parameters such as charset.
        const mediaType = normalizeAttachmentMediaType(part.mime)
        return {
          uri: part.url,
          ...(typeof part.filename === "string" ? { name: part.filename } : {}),
          ...(mediaType ? { description: mediaType } : {}),
        }
      })
    const depth = await sessionDepth(sessionID)

    const results = await Promise.all(mentions.map(async (mention) => {
      if (["router", "router-control", ...Object.keys(LEGACY_AGENT_MODES)].includes(mention.name)) {
        throw new Error(`Claude cannot delegate an explicit mention to managed router agent ${mention.name}`)
      }
      const effective = await resolveFor({ sessionID, agent: mention.name })
      const maximumDepth = effective.policy.limits?.max_child_depth
      if (maximumDepth !== undefined && depth >= maximumDepth) {
        throw new Error(`llm-router restricted limit max_child_depth ${maximumDepth} exceeded`)
      }
      const child = responseData(await sessions.create(
        {
          directory,
          parentID: sessionID,
          title: `llm-router @${mention.name}`,
          agent: mention.name,
          permission: effective.policy.permissions,
        },
        { throwOnError: true },
      ))
      if (typeof child?.id !== "string" || !child.id) {
        throw new Error(`OpenCode did not create a child session for @${mention.name}`)
      }
      rememberTurn(child.id, `llm-router-child:${child.id}`, effective.policy)
      await v2SessionClient.prompt(
        {
          sessionID: child.id,
          prompt: { text: request, ...(files.length > 0 ? { files } : {}) },
          resume: true,
        },
        { throwOnError: true },
      )
      await v2SessionClient.wait(
        { sessionID: child.id },
        { throwOnError: true },
      )
      const context = responseData(await v2SessionClient.context(
        { sessionID: child.id },
        { throwOnError: true },
      ))
      const assistant = Array.isArray(context)
        ? context.findLast((message) => message?.type === "assistant" && message.error === undefined)
        : undefined
      const text = assistant?.content
        ?.filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("")
      if (!text?.trim()) throw new Error(`OpenCode agent @${mention.name} returned no text result`)
      if (Buffer.byteLength(text, "utf8") > MAX_AGENT_RESULT_BYTES) {
        throw new Error(`OpenCode agent @${mention.name} result exceeded ${MAX_AGENT_RESULT_BYTES} bytes`)
      }
      return {
        type: "text",
        text: `\n\n[Completed result from OpenCode agent @${mention.name}]\n${text}`,
      }
    }))

    let resultIndex = 0
    // OpenCode validates every part before saving the message and rejects one
    // without identifiers, so the delegated result inherits them from the
    // mention it replaces.
    return parts.map((part) => {
      if (part?.type !== "agent") return part
      const result = results[resultIndex++]
      for (const field of ["id", "sessionID", "messageID"]) {
        if (typeof part[field] === "string") result[field] = part[field]
      }
      return result
    })
  }

  async function countTool(sessionID, toolName, { agentID } = {}) {
    const key = activeTurns.get(sessionID)
    const turn = key ? turns.get(key) : undefined
    if (!turn) return
    turn.toolCalls += 1
    const maximum = turn.policy.limits?.max_tool_calls
    if (maximum !== undefined && turn.toolCalls > maximum) {
      throw new Error(`llm-router restricted limit max_tool_calls ${maximum} exceeded`)
    }
    const childMaximum = turn.policy.limits?.max_child_depth
    if (
      childMaximum !== undefined
      && ["agent", "task"].includes(String(toolName).toLowerCase())
      && await sessionDepth(sessionID) + (agentID ? 1 : 0) >= childMaximum
    ) {
      throw new Error(`llm-router restricted limit max_child_depth ${childMaximum} exceeded`)
    }
  }

  async function toolBefore(input) {
    await countTool(input.sessionID, input.tool)
  }

  function settlePermission(requestID, result) {
    const pending = pendingPermissions.get(requestID)
    if (!pending) return
    pendingPermissions.delete(requestID)
    clearTimeout(pending.timeout)
    pending.signal?.removeEventListener("abort", pending.abort)
    pending.resolve(result)
  }

  async function askClaudePermission(sessionID, agent, toolName, input, options = {}) {
    try {
      await countTool(sessionID, toolName, { agentID: options.agentID })
    } catch (error) {
      return permissionResult("deny", error.message)
    }
    if (options.signal?.aborted) return permissionResult("deny", "Permission request was cancelled")
    const permission = v2SessionClient?.permission
    if (typeof permission?.create !== "function") {
      return permissionResult("deny", "OpenCode permission request API is unavailable")
    }
    const requestID = randomUUID()
    const waiting = new Promise((resolve) => {
      const abort = () => settlePermission(
        requestID,
        permissionResult("deny", "Permission request was cancelled"),
      )
      const timeout = setTimeout(() => settlePermission(
        requestID,
        permissionResult("deny", `Permission request timed out after ${permissionTimeoutMs}ms`),
      ), permissionTimeoutMs)
      pendingPermissions.set(requestID, {
        resolve,
        timeout,
        signal: options.signal,
        abort,
        sessionID,
      })
      options.signal?.addEventListener("abort", abort, { once: true })
    })
    let created
    try {
      created = responseData(await permission.create(
        {
          sessionID,
          id: requestID,
          action: toolAction(toolName),
          resources: toolResources(toolName, input),
          metadata: { toolName, toolUseID: options.toolUseID },
          agent,
        },
        { throwOnError: true },
      ))
    } catch {
      settlePermission(requestID, permissionResult("deny", "OpenCode permission request failed"))
      return waiting
    }
    if (created?.effect === "allow" || created?.effect === "deny") {
      settlePermission(requestID, permissionResult(created.effect))
    } else if (created?.effect !== "ask") {
      settlePermission(requestID, permissionResult("deny", "OpenCode returned an invalid permission effect"))
    }
    return waiting
  }

  async function chatParams(input, output) {
    const key = turnKey(input.sessionID, input.message.id)
    let turn = turns.get(key)
    if (!turn) {
      const activeKey = activeTurns.get(input.sessionID)
      turn = activeKey ? turns.get(activeKey) : undefined
      if (turn) {
        activateTurn(input.sessionID, key, turn)
      }
    }
    if (!turn) return
    turn.steps += 1
    const maximum = turn.policy.limits?.max_steps
    if (maximum !== undefined && turn.steps > maximum) {
      throw new Error(`llm-router restricted limit max_steps ${maximum} exceeded`)
    }
    if (input.model.providerID !== "claude-agent") return
    if (maximum !== undefined) output.options.maxTurns = maximum
    if (turn.policy.profile === "native") return
    if (turn.policy.profile === "full") {
      output.options.permissionProfile = { mode: "default", default: "allow" }
      return
    }
    output.options.permissionProfile = { mode: "default", default: "ask" }
    output.options.permissionCallback = (toolName, toolInput, options) => askClaudePermission(
      input.sessionID,
      input.agent,
      toolName,
      toolInput,
      options,
    )
  }

  async function event(event) {
    if (event?.type !== "permission.v2.replied") return
    const properties = event.properties ?? event.data
    const pending = pendingPermissions.get(properties?.requestID)
    if (!pending || pending.sessionID !== properties.sessionID) return
    const effect = ["once", "always"].includes(properties.reply) ? "allow" : "deny"
    settlePermission(properties.requestID, permissionResult(effect))
  }

  async function describe(sessionID, agent) {
    const effective = await resolveFor({ sessionID })
    const mode = LEGACY_AGENT_MODES[agent] ?? effective.state.mode
    return { mode, profile: effective.policy.profile }
  }

  async function dispose() {
    for (const requestID of [...pendingPermissions.keys()]) {
      settlePermission(requestID, permissionResult("deny", "Router control was disposed"))
    }
    turns.clear()
    activeTurns.clear()
  }

  return {
    applyTurn,
    chatParams,
    commandBefore,
    controlState,
    describe,
    dispose,
    event,
    rememberTurn,
    resolveAgentMentions,
    resolveFor,
    routingAgent,
    toolBefore,
  }
}
