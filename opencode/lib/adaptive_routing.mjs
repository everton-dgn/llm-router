import {
  LEGACY_ROUTE_MANIFEST,
  routeManifestEntry,
} from "./route_manifest.mjs"
import { routeSupportsSelectedRequest } from "./routing_policy.mjs"

export const ROUTING_STATE_METADATA_KEY = "llm-router.routing.state"
export const ROUTING_STATE_SCHEMA_VERSION = 1

export const DEFAULT_ADAPTIVE_ROUTING_POLICY = Object.freeze({
  minimumTurnsBeforeSwitch: 2,
  downgradeConfirmations: 2,
  switchCooldownTurns: 1,
})

const routerModes = new Set(["auto", "adaptive", "pinned"])

const modeByAgent = Object.freeze({
  "router-auto": "auto",
  "router-adaptive": "adaptive",
  "router-manual": "pinned",
})

function exactInteger(value, name, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be an integer of at least ${minimum}`)
  }
  return value
}

function exactRoute(route, manifest) {
  if (!routeManifestEntry(manifest, route)) {
    throw new Error(`Unknown adaptive route: ${route}`)
  }
  return route
}

function nextCooldown(state) {
  return Math.max(0, state.cooldownTurnsRemaining - 1)
}

function baseState({ sessionID, mode, currentRoute, turnsOnCurrent, cooldownTurnsRemaining }) {
  return {
    schemaVersion: ROUTING_STATE_SCHEMA_VERSION,
    sessionID,
    mode,
    currentRoute,
    turnsOnCurrent,
    cooldownTurnsRemaining,
  }
}

export function normalizeAdaptiveRoutingPolicy(policy = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("adaptivePolicy must be an object")
  }
  return {
    minimumTurnsBeforeSwitch: exactInteger(
      policy.minimumTurnsBeforeSwitch
        ?? DEFAULT_ADAPTIVE_ROUTING_POLICY.minimumTurnsBeforeSwitch,
      "minimumTurnsBeforeSwitch",
      1,
    ),
    downgradeConfirmations: exactInteger(
      policy.downgradeConfirmations
        ?? DEFAULT_ADAPTIVE_ROUTING_POLICY.downgradeConfirmations,
      "downgradeConfirmations",
      1,
    ),
    switchCooldownTurns: exactInteger(
      policy.switchCooldownTurns
        ?? DEFAULT_ADAPTIVE_ROUTING_POLICY.switchCooldownTurns,
      "switchCooldownTurns",
      0,
    ),
  }
}

export function routerModeForAgent(agent) {
  if (agent === "router") return
  return modeByAgent[agent]
}

export function isManagedRouterAgent(agent) {
  return agent === "router" || routerModeForAgent(agent) !== undefined
}

export function readRoutingState(
  metadata,
  sessionID,
  manifest = LEGACY_ROUTE_MANIFEST,
) {
  const stored = metadata?.[ROUTING_STATE_METADATA_KEY]
  if (stored === undefined) return
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    throw new Error("OpenCode session has invalid llm-router routing state")
  }
  if (stored.sessionID !== sessionID) return
  if (
    stored.schemaVersion !== ROUTING_STATE_SCHEMA_VERSION
    || !routerModes.has(stored.mode)
  ) {
    throw new Error("OpenCode session has invalid llm-router routing state")
  }
  if (typeof stored.currentRoute !== "string" || !stored.currentRoute) {
    throw new Error("OpenCode session has invalid llm-router routing state")
  }
  exactInteger(stored.turnsOnCurrent, "turnsOnCurrent", 1)
  exactInteger(stored.cooldownTurnsRemaining, "cooldownTurnsRemaining", 0)
  if (!routeManifestEntry(manifest, stored.currentRoute)) {
    return {
      ...stored,
      currentRoute: undefined,
      pendingDowngrade: undefined,
    }
  }
  if (stored.pendingDowngrade !== undefined) {
    if (
      !stored.pendingDowngrade
      || typeof stored.pendingDowngrade !== "object"
      || Array.isArray(stored.pendingDowngrade)
    ) {
      throw new Error("OpenCode session has invalid adaptive downgrade state")
    }
    if (
      typeof stored.pendingDowngrade.route !== "string"
      || !stored.pendingDowngrade.route
    ) {
      throw new Error("OpenCode session has invalid adaptive downgrade state")
    }
    exactInteger(stored.pendingDowngrade.confirmations, "downgrade confirmations", 1)
    if (!routeManifestEntry(manifest, stored.pendingDowngrade.route)) {
      return { ...stored, pendingDowngrade: undefined }
    }
  }
  return stored
}

export function resolveRoutingMode({ agent, state, hasLegacyPinnedTarget = false }) {
  const aliased = routerModeForAgent(agent)
  if (aliased) return aliased
  if (agent !== "router") return
  return state?.mode ?? (hasLegacyPinnedTarget ? "pinned" : "adaptive")
}

export function isShortFollowUp(request) {
  if (typeof request !== "string") return false
  const text = request.trim()
  if (!text || text.length > 80) return false
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (words.length > 6) return false
  return /^(?:e\b|and\b|also\b|tamb[eé]m\b|agora\b|then\b|depois\b|continue\b|continua\b|isso\b|isto\b|essa\b|esse\b|that\b|this\b|what\s+about\b)/iu.test(text)
}

export function transitionRoutingState({
  state,
  sessionID,
  mode,
  recommendedRoute,
  request = "",
  requirements = {},
  policy,
  manifest = LEGACY_ROUTE_MANIFEST,
}) {
  if (typeof sessionID !== "string" || !sessionID) {
    throw new Error("OpenCode session ID is required for adaptive routing")
  }
  if (!routerModes.has(mode)) throw new Error(`Unknown router mode: ${mode}`)
  exactRoute(recommendedRoute, manifest)
  const thresholds = normalizeAdaptiveRoutingPolicy(policy)
  const current = state?.mode === mode
    && routeManifestEntry(manifest, state.currentRoute)
    ? state
    : undefined

  if (!current) {
    return baseState({
      sessionID,
      mode,
      currentRoute: recommendedRoute,
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: mode === "adaptive"
        ? thresholds.switchCooldownTurns
        : 0,
    })
  }

  if (mode === "pinned") {
    return baseState({
      sessionID,
      mode,
      currentRoute: current.currentRoute,
      turnsOnCurrent: current.turnsOnCurrent + 1,
      cooldownTurnsRemaining: 0,
    })
  }

  if (mode === "auto") {
    return baseState({
      sessionID,
      mode,
      currentRoute: recommendedRoute,
      turnsOnCurrent: current.currentRoute === recommendedRoute
        ? current.turnsOnCurrent + 1
        : 1,
      cooldownTurnsRemaining: 0,
    })
  }

  // Only a real switch resets the turn accounting, so the compatibility check
  // runs after the same-route branch.
  if (
    current.currentRoute !== recommendedRoute
    && !routeSupportsSelectedRequest(
      current.currentRoute,
      recommendedRoute,
      request,
      requirements,
      manifest,
    )
  ) {
    return baseState({
      sessionID,
      mode,
      currentRoute: recommendedRoute,
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: thresholds.switchCooldownTurns,
    })
  }

  if (current.currentRoute === recommendedRoute) {
    return baseState({
      sessionID,
      mode,
      currentRoute: current.currentRoute,
      turnsOnCurrent: current.turnsOnCurrent + 1,
      cooldownTurnsRemaining: nextCooldown(current),
    })
  }

  const currentRank = routeManifestEntry(manifest, current.currentRoute).order
  const recommendedRank = routeManifestEntry(manifest, recommendedRoute).order
  if (recommendedRank > currentRank) {
    return baseState({
      sessionID,
      mode,
      currentRoute: recommendedRoute,
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: thresholds.switchCooldownTurns,
    })
  }

  if (isShortFollowUp(request)) {
    return baseState({
      sessionID,
      mode,
      currentRoute: current.currentRoute,
      turnsOnCurrent: current.turnsOnCurrent + 1,
      cooldownTurnsRemaining: nextCooldown(current),
    })
  }

  const confirmations = current.pendingDowngrade?.route === recommendedRoute
    ? current.pendingDowngrade.confirmations + 1
    : 1
  const canSwitch = current.turnsOnCurrent >= thresholds.minimumTurnsBeforeSwitch
    && current.cooldownTurnsRemaining === 0
    && confirmations >= thresholds.downgradeConfirmations

  if (canSwitch) {
    return baseState({
      sessionID,
      mode,
      currentRoute: recommendedRoute,
      turnsOnCurrent: 1,
      cooldownTurnsRemaining: thresholds.switchCooldownTurns,
    })
  }

  return {
    ...baseState({
      sessionID,
      mode,
      currentRoute: current.currentRoute,
      turnsOnCurrent: current.turnsOnCurrent + 1,
      cooldownTurnsRemaining: nextCooldown(current),
    }),
    pendingDowngrade: { route: recommendedRoute, confirmations },
  }
}
