import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

export const EXECUTION_POLICY_SCHEMA_VERSION = 1
export const EXECUTION_PROFILES = Object.freeze(["native", "restricted", "full"])

const profileSet = new Set(EXECUTION_PROFILES)
const actions = new Set(["allow", "ask", "deny"])
const actionRank = Object.freeze({ deny: 0, ask: 1, allow: 2 })
const limitDefinitions = Object.freeze({
  max_steps: Object.freeze({ minimum: 1, maximum: 10_000 }),
  max_tool_calls: Object.freeze({ minimum: 1, maximum: 100_000 }),
  max_child_depth: Object.freeze({ minimum: 0, maximum: 1 }),
})
const builtInDefaultsPath = fileURLToPath(
  new URL("../llm-router.policy.defaults.json", import.meta.url),
)

function clone(value) {
  return structuredClone(value)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertObject(value, path) {
  if (!isObject(value)) throw new Error(`${path} must be an object`)
}

function assertKnownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not supported`)
  }
}

function validateProfileName(value, path) {
  if (!profileSet.has(value)) {
    throw new Error(`${path} must be one of: ${EXECUTION_PROFILES.join(", ")}`)
  }
}

function validatePermissions(value, path) {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  value.forEach((rule, index) => {
    const rulePath = `${path}[${index}]`
    assertObject(rule, rulePath)
    assertKnownKeys(rule, new Set(["permission", "pattern", "action"]), rulePath)
    if (typeof rule.permission !== "string" || rule.permission.length === 0) {
      throw new Error(`${rulePath}.permission must be a non-empty string`)
    }
    if (typeof rule.pattern !== "string" || rule.pattern.length === 0) {
      throw new Error(`${rulePath}.pattern must be a non-empty string`)
    }
    if (!actions.has(rule.action)) {
      throw new Error(`${rulePath}.action must be one of: allow, ask, deny`)
    }
  })
}

function validateLimits(value, path) {
  assertObject(value, path)
  assertKnownKeys(value, new Set(Object.keys(limitDefinitions)), path)
  for (const [name, number] of Object.entries(value)) {
    const { minimum, maximum } = limitDefinitions[name]
    if (!Number.isInteger(number) || number < minimum) {
      const qualifier = minimum === 0 ? "non-negative integer" : "positive integer"
      throw new Error(`${path}.${name} must be a ${qualifier}`)
    }
    if (number > maximum) {
      throw new Error(`${path}.${name} must be at most ${maximum}`)
    }
  }
}

function validatePolicyFragment(value, path, { requireProfile = false } = {}) {
  assertObject(value, path)
  assertKnownKeys(value, new Set(["profile", "permissions", "limits"]), path)
  if (requireProfile && value.profile === undefined) {
    throw new Error(`${path}.profile is required`)
  }
  if (value.profile !== undefined) validateProfileName(value.profile, `${path}.profile`)
  if (value.permissions !== undefined) validatePermissions(value.permissions, `${path}.permissions`)
  if (value.limits !== undefined) validateLimits(value.limits, `${path}.limits`)
}

function normalizeAssignment(value, path) {
  if (typeof value === "string") {
    validateProfileName(value, path)
    return { profile: value }
  }
  validatePolicyFragment(value, path, { requireProfile: true })
  return clone(value)
}

function validateAssignments(value, path, { model = false } = {}) {
  assertObject(value, path)
  for (const [selector, assignment] of Object.entries(value)) {
    if (selector.length === 0 || selector.includes("*")) {
      const expected = model ? "an exact provider/model identifier" : "an exact agent identifier"
      throw new Error(`${path}.${selector || "<empty>"} must use ${expected}`)
    }
    if (model && !/^[^/\s]+\/[^\s]+$/.test(selector)) {
      throw new Error(`${path}.${selector} must use an exact provider/model identifier`)
    }
    normalizeAssignment(assignment, `${path}.${selector}`)
  }
}

function validateProfiles(value, path, { complete = false } = {}) {
  assertObject(value, path)
  for (const [profile, settings] of Object.entries(value)) {
    validateProfileName(profile, `${path} key`)
    validatePolicyFragment(settings, `${path}.${profile}`)
  }
  if (complete) {
    for (const profile of EXECUTION_PROFILES) {
      if (!Object.hasOwn(value, profile)) throw new Error(`${path}.${profile} is required`)
      if (!Array.isArray(value[profile].permissions)) {
        throw new Error(`${path}.${profile}.permissions is required`)
      }
      if (!isObject(value[profile].limits)) throw new Error(`${path}.${profile}.limits is required`)
    }
  }
}

export function validateExecutionPolicyConfig(config, { complete = false, source = "policy" } = {}) {
  assertObject(config, source)
  assertKnownKeys(
    config,
    new Set(["$schema", "schemaVersion", "defaultProfile", "agents", "models", "profiles"]),
    source,
  )
  if (config.$schema !== undefined && typeof config.$schema !== "string") {
    throw new Error(`${source}.$schema must be a string`)
  }
  if (config.schemaVersion !== undefined && config.schemaVersion !== EXECUTION_POLICY_SCHEMA_VERSION) {
    throw new Error(
      `${source}.schemaVersion must be ${EXECUTION_POLICY_SCHEMA_VERSION}`,
    )
  }
  if (complete && config.schemaVersion === undefined) {
    throw new Error(`${source}.schemaVersion is required`)
  }
  if (config.defaultProfile !== undefined) {
    validateProfileName(config.defaultProfile, `${source}.defaultProfile`)
  } else if (complete) {
    throw new Error(`${source}.defaultProfile is required`)
  }
  if (config.agents !== undefined) validateAssignments(config.agents, `${source}.agents`)
  else if (complete) throw new Error(`${source}.agents is required`)
  if (config.models !== undefined) validateAssignments(config.models, `${source}.models`, { model: true })
  else if (complete) throw new Error(`${source}.models is required`)
  if (config.profiles !== undefined) validateProfiles(config.profiles, `${source}.profiles`, { complete })
  else if (complete) throw new Error(`${source}.profiles is required`)
  return clone(config)
}

function mergeLimits(base = {}, overlay = {}) {
  return { ...clone(base), ...clone(overlay) }
}

function mergePolicyFragment(base = {}, overlay = {}) {
  const merged = clone(base)
  if (overlay.profile !== undefined) merged.profile = overlay.profile
  if (overlay.permissions !== undefined) merged.permissions = clone(overlay.permissions)
  if (overlay.limits !== undefined) merged.limits = mergeLimits(base.limits, overlay.limits)
  return merged
}

function applyUnrestrictedLayer(base, layer) {
  const merged = clone(base)
  if (layer.defaultProfile !== undefined) merged.defaultProfile = layer.defaultProfile

  for (const collection of ["agents", "models"]) {
    if (!layer[collection]) continue
    merged[collection] ??= {}
    for (const [selector, assignment] of Object.entries(layer[collection])) {
      merged[collection][selector] = normalizeAssignment(
        assignment,
        `global.${collection}.${selector}`,
      )
    }
  }

  if (layer.profiles) {
    for (const [profile, settings] of Object.entries(layer.profiles)) {
      merged.profiles[profile] = mergePolicyFragment(merged.profiles[profile], settings)
    }
  }
  return merged
}

function canRestrictProfile(current, requested) {
  if (current === requested) return true
  return requested === "restricted" && (current === "native" || current === "full")
}

function globMatches(pattern, value) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

function ruleCovers(rule, permission, pattern) {
  return globMatches(rule.permission, permission) && globMatches(rule.pattern, pattern)
}

function effectiveAction(rules, permission, pattern) {
  let action
  for (const rule of rules) {
    if (ruleCovers(rule, permission, pattern)) action = rule.action
  }
  return action
}

function mergeRestrictivePermissions(base, overlay, path) {
  const merged = clone(base)
  for (const rule of overlay) {
    const exactIndex = merged.findIndex(
      (candidate) => candidate.permission === rule.permission && candidate.pattern === rule.pattern,
    )
    const baselineAction = effectiveAction(base, rule.permission, rule.pattern)
    if (rule.action !== "deny" && baselineAction === undefined) {
      throw new Error(`${path} would widen a permission without an explicit baseline`)
    }
    if (baselineAction !== undefined && actionRank[rule.action] > actionRank[baselineAction]) {
      throw new Error(`${path} would widen ${rule.permission}:${rule.pattern}`)
    }
    if (exactIndex === -1 && rule.action !== "deny") {
      const coveredRestriction = base.find(
        (candidate) => ruleCovers(rule, candidate.permission, candidate.pattern)
          && actionRank[candidate.action] < actionRank[rule.action],
      )
      if (coveredRestriction) {
        throw new Error(
          `${path} would widen ${coveredRestriction.permission}:${coveredRestriction.pattern}`,
        )
      }
    }
    if (exactIndex === -1) merged.push(clone(rule))
    else merged[exactIndex] = clone(rule)
  }
  return merged
}

function mergeRestrictiveLimits(base, overlay, path) {
  const merged = clone(base)
  for (const [name, value] of Object.entries(overlay)) {
    if (merged[name] !== undefined && value > merged[name]) {
      throw new Error(`${path}.${name} would widen the project limit`)
    }
    merged[name] = value
  }
  return merged
}

function restrictFragment(base, overlay, path) {
  const merged = clone(base)
  if (overlay.profile !== undefined) {
    if (!canRestrictProfile(base.profile, overlay.profile)) {
      throw new Error(`${path} would widen profile ${base.profile} to ${overlay.profile}`)
    }
    merged.profile = overlay.profile
  }
  if (overlay.permissions !== undefined) {
    merged.permissions = mergeRestrictivePermissions(
      base.permissions ?? [],
      overlay.permissions,
      `${path}.permissions`,
    )
  }
  if (overlay.limits !== undefined) {
    merged.limits = mergeRestrictiveLimits(
      base.limits ?? {},
      overlay.limits,
      `${path}.limits`,
    )
  }
  return merged
}

function effectiveAssignmentFragment(policy, assignment) {
  const normalized = normalizeAssignment(assignment, "assignment")
  return mergePolicyFragment(policy.profiles[normalized.profile], normalized)
}

function constrainExistingAssignments(policy, profile, restrictions) {
  for (const collection of ["agents", "models"]) {
    for (const [selector, assignment] of Object.entries(policy[collection])) {
      if (assignment.profile !== profile) continue
      const constrained = clone(assignment)
      if (assignment.permissions !== undefined && restrictions.permissions !== undefined) {
        let permissions = clone(assignment.permissions)
        for (const rule of restrictions.permissions) {
          const currentAction = effectiveAction(
            permissions,
            rule.permission,
            rule.pattern,
          )
          if (currentAction === undefined && rule.action !== "deny") continue
          if (currentAction !== undefined && actionRank[rule.action] >= actionRank[currentAction]) {
            continue
          }
          permissions = mergeRestrictivePermissions(
            permissions,
            [rule],
            `project.profiles.${profile}.${collection}.${selector}.permissions`,
          )
        }
        constrained.permissions = permissions
      }
      if (assignment.limits !== undefined && restrictions.limits !== undefined) {
        constrained.limits = clone(assignment.limits)
        for (const [name, limit] of Object.entries(restrictions.limits)) {
          if (constrained.limits[name] !== undefined && constrained.limits[name] > limit) {
            constrained.limits[name] = limit
          }
        }
      }
      policy[collection][selector] = constrained
    }
  }
}

function applyRestrictiveLayer(base, layer) {
  const merged = clone(base)
  if (layer.defaultProfile !== undefined) {
    if (!canRestrictProfile(base.defaultProfile, layer.defaultProfile)) {
      throw new Error(
        `project.defaultProfile would widen profile ${base.defaultProfile} to ${layer.defaultProfile}`,
      )
    }
    merged.defaultProfile = layer.defaultProfile
  }

  if (layer.profiles) {
    for (const [profile, settings] of Object.entries(layer.profiles)) {
      merged.profiles[profile] = restrictFragment(
        { profile, ...merged.profiles[profile] },
        settings,
        `project.profiles.${profile}`,
      )
      delete merged.profiles[profile].profile
      constrainExistingAssignments(merged, profile, settings)
    }
  }

  for (const collection of ["agents", "models"]) {
    if (!layer[collection]) continue
    merged[collection] ??= {}
    for (const [selector, rawAssignment] of Object.entries(layer[collection])) {
      const overlay = normalizeAssignment(rawAssignment, `project.${collection}.${selector}`)
      const currentAssignment = merged[collection][selector] ?? { profile: merged.defaultProfile }
      if (!canRestrictProfile(currentAssignment.profile, overlay.profile)) {
        throw new Error(
          `project.${collection}.${selector} would widen profile ${currentAssignment.profile} to ${overlay.profile}`,
        )
      }
      const targetBase = effectiveAssignmentFragment(merged, {
        ...(currentAssignment.profile === overlay.profile ? currentAssignment : {}),
        profile: overlay.profile,
      })
      const restricted = restrictFragment(
        { profile: overlay.profile, ...targetBase },
        overlay,
        `project.${collection}.${selector}`,
      )
      const sameProfile = currentAssignment.profile === overlay.profile
      merged[collection][selector] = {
        profile: restricted.profile,
        ...(
          overlay.permissions !== undefined
          || (sameProfile && currentAssignment.permissions !== undefined)
            ? { permissions: restricted.permissions }
            : {}
        ),
        ...(
          overlay.limits !== undefined
          || (sameProfile && currentAssignment.limits !== undefined)
            ? { limits: restricted.limits }
            : {}
        ),
      }
    }
  }
  return merged
}

export function mergeExecutionPolicyLayers({ defaults, global, project }) {
  validateExecutionPolicyConfig(defaults, { complete: true, source: "defaults" })
  let merged = clone(defaults)
  if (global !== undefined) {
    validateExecutionPolicyConfig(global, { source: "global" })
    merged = applyUnrestrictedLayer(merged, global)
  }
  if (project !== undefined) {
    validateExecutionPolicyConfig(project, { source: "project" })
    merged = applyRestrictiveLayer(merged, project)
  }
  validateExecutionPolicyConfig(merged, { complete: true, source: "merged policy" })
  return merged
}

function sessionAssignment(value) {
  return normalizeAssignment(value, "sessionOverride")
}

export function resolveExecutionPolicy(
  policy,
  { agent, providerID, modelID, sessionOverride } = {},
) {
  validateExecutionPolicyConfig(policy, { complete: true })
  let assignment = { profile: policy.defaultProfile }
  let source = "default"
  let selector = "defaultProfile"

  if (agent && Object.hasOwn(policy.agents, agent)) {
    assignment = normalizeAssignment(policy.agents[agent], `agents.${agent}`)
    source = "agent"
    selector = agent
  }
  const modelSelector = providerID && modelID ? `${providerID}/${modelID}` : undefined
  if (modelSelector && Object.hasOwn(policy.models, modelSelector)) {
    assignment = normalizeAssignment(policy.models[modelSelector], `models.${modelSelector}`)
    source = "model"
    selector = modelSelector
  }
  if (sessionOverride !== undefined) {
    assignment = sessionAssignment(sessionOverride)
    source = "session"
    selector = "explicit"
  }

  const profile = policy.profiles[assignment.profile]
  return {
    profile: assignment.profile,
    source,
    selector,
    permissions: clone(assignment.permissions ?? profile.permissions),
    limits: mergeLimits(profile.limits, assignment.limits),
  }
}

async function readJson(path, { optional = false } = {}) {
  try {
    const source = await readFile(path, "utf8")
    try {
      return JSON.parse(source)
    } catch (error) {
      throw new Error(`${path} must contain valid JSON: ${error.message}`, { cause: error })
    }
  } catch (error) {
    if (optional && error?.code === "ENOENT") return undefined
    throw error
  }
}

export async function loadExecutionPolicy({
  defaultsPath = builtInDefaultsPath,
  globalPath,
  projectPath,
} = {}) {
  const [defaults, global, project] = await Promise.all([
    readJson(defaultsPath),
    globalPath ? readJson(globalPath, { optional: true }) : undefined,
    projectPath ? readJson(projectPath, { optional: true }) : undefined,
  ])
  return mergeExecutionPolicyLayers({ defaults, global, project })
}
