import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  EXECUTION_POLICY_SCHEMA_VERSION,
  EXECUTION_PROFILES,
  loadExecutionPolicy,
  mergeExecutionPolicyLayers,
  resolveExecutionPolicy,
  validateExecutionPolicyConfig,
} from "../opencode/lib/execution_policy.mjs"

const allowAll = [{ permission: "*", pattern: "*", action: "allow" }]
const denyBash = [{ permission: "bash", pattern: "*", action: "deny" }]

function basePolicy() {
  return {
    schemaVersion: 1,
    defaultProfile: "restricted",
    agents: {
      router: { profile: "restricted" },
      claude: { profile: "native" },
    },
    models: {
      "claude-agent/claude-opus-5": { profile: "native" },
      "openai/gpt-5.6-sol": { profile: "restricted" },
    },
    profiles: {
      native: { permissions: [], limits: {} },
      restricted: {
        permissions: [
          { permission: "*", pattern: "*", action: "ask" },
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "external_directory", pattern: "*", action: "deny" },
        ],
        limits: { max_steps: 40, max_tool_calls: 80, max_child_depth: 1 },
      },
      full: { permissions: allowAll, limits: {} },
    },
  }
}

test("exports the three execution profiles and schema version", () => {
  assert.equal(EXECUTION_POLICY_SCHEMA_VERSION, 1)
  assert.deepEqual(EXECUTION_PROFILES, ["native", "restricted", "full"])
})

test("validates a complete execution policy", () => {
  assert.deepEqual(validateExecutionPolicyConfig(basePolicy(), { complete: true }), basePolicy())
})

test("rejects unknown profiles, wildcard model selectors, malformed permissions and invalid limits", () => {
  assert.throws(
    () => validateExecutionPolicyConfig({ defaultProfile: "unlimited" }),
    /defaultProfile.*native, restricted, full/,
  )
  assert.throws(
    () => validateExecutionPolicyConfig({ models: { "openai/*": "full" } }),
    /models.*exact provider\/model identifier/,
  )
  assert.throws(
    () => validateExecutionPolicyConfig({
      profiles: { restricted: { permissions: [{ permission: "bash", pattern: "*", action: "yes" }] } },
    }),
    /action.*allow, ask, deny/,
  )
  assert.throws(
    () => validateExecutionPolicyConfig({
      profiles: { restricted: { limits: { max_steps: 0 } } },
    }),
    /max_steps.*positive integer/,
  )
  assert.throws(
    () => validateExecutionPolicyConfig({
      profiles: { restricted: { limits: { max_child_depth: 2 } } },
    }),
    /max_child_depth.*at most 1/,
  )
})

test("global config may widen an assignment and replace a profile policy", () => {
  const merged = mergeExecutionPolicyLayers({
    defaults: basePolicy(),
    global: {
      defaultProfile: "full",
      agents: { router: "full" },
      profiles: {
        restricted: {
          permissions: denyBash,
          limits: { max_steps: 25 },
        },
      },
    },
  })

  assert.equal(merged.defaultProfile, "full")
  assert.deepEqual(merged.agents.router, { profile: "full" })
  assert.deepEqual(merged.profiles.restricted.permissions, denyBash)
  assert.deepEqual(merged.profiles.restricted.limits, {
    max_steps: 25,
    max_tool_calls: 80,
    max_child_depth: 1,
  })
})

test("project config may restrict full or native assignments", () => {
  const merged = mergeExecutionPolicyLayers({
    defaults: basePolicy(),
    global: {
      defaultProfile: "full",
      agents: { router: "full", claude: "native" },
      models: { "openai/gpt-5.6-sol": "full" },
    },
    project: {
      defaultProfile: "restricted",
      agents: { router: "restricted", claude: "restricted" },
      models: { "openai/gpt-5.6-sol": "restricted" },
    },
  })

  assert.equal(merged.defaultProfile, "restricted")
  assert.deepEqual(merged.agents.router, { profile: "restricted" })
  assert.deepEqual(merged.agents.claude, { profile: "restricted" })
  assert.deepEqual(merged.models["openai/gpt-5.6-sol"], { profile: "restricted" })
})

test("project config rejects attempts to widen assignments or permissions", () => {
  assert.throws(
    () => mergeExecutionPolicyLayers({
      defaults: basePolicy(),
      project: { agents: { router: "full" } },
    }),
    /project.*agents\.router.*widen/i,
  )
  assert.throws(
    () => mergeExecutionPolicyLayers({
      defaults: basePolicy(),
      project: {
        profiles: {
          restricted: {
            permissions: [{ permission: "external_directory", pattern: "*", action: "allow" }],
          },
        },
      },
    }),
    /project.*profiles\.restricted\.permissions.*widen/i,
  )
  assert.throws(
    () => mergeExecutionPolicyLayers({
      defaults: basePolicy(),
      project: { profiles: { restricted: { limits: { max_steps: 50 } } } },
    }),
    /project.*max_steps.*widen/i,
  )
})

test("project config can add deny rules, convert allow to ask and lower limits", () => {
  const merged = mergeExecutionPolicyLayers({
    defaults: basePolicy(),
    project: {
      profiles: {
        restricted: {
          permissions: [
            { permission: "read", pattern: "*", action: "ask" },
            { permission: "webfetch", pattern: "*", action: "deny" },
          ],
          limits: { max_steps: 20, max_child_depth: 0 },
        },
      },
    },
  })

  assert.deepEqual(merged.profiles.restricted.permissions, [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "deny" },
    { permission: "webfetch", pattern: "*", action: "deny" },
  ])
  assert.deepEqual(merged.profiles.restricted.limits, {
    max_steps: 20,
    max_tool_calls: 80,
    max_child_depth: 0,
  })
})

test("project assignment overrides preserve restrictions from the global assignment", () => {
  const merged = mergeExecutionPolicyLayers({
    defaults: basePolicy(),
    global: {
      agents: {
        router: {
          profile: "restricted",
          permissions: denyBash,
          limits: { max_steps: 12 },
        },
      },
    },
    project: {
      agents: {
        router: {
          profile: "restricted",
          permissions: [{ permission: "edit", pattern: "*", action: "deny" }],
        },
      },
    },
  })

  assert.deepEqual(merged.agents.router, {
    profile: "restricted",
    permissions: [
      { permission: "bash", pattern: "*", action: "deny" },
      { permission: "edit", pattern: "*", action: "deny" },
    ],
    limits: { max_steps: 12, max_tool_calls: 80, max_child_depth: 1 },
  })
})

test("project profile restrictions also constrain existing exact assignments", () => {
  const merged = mergeExecutionPolicyLayers({
    defaults: basePolicy(),
    global: {
      agents: {
        router: {
          profile: "restricted",
          permissions: allowAll,
          limits: { max_steps: 60 },
        },
      },
    },
    project: {
      profiles: {
        restricted: {
          permissions: denyBash,
          limits: { max_steps: 20 },
        },
      },
    },
  })

  assert.deepEqual(merged.agents.router, {
    profile: "restricted",
    permissions: [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "deny" },
    ],
    limits: { max_steps: 20 },
  })
})

test("exact model override wins over the stable agent assignment", () => {
  const resolved = resolveExecutionPolicy(basePolicy(), {
    agent: "router",
    providerID: "claude-agent",
    modelID: "claude-opus-5",
  })

  assert.equal(resolved.profile, "native")
  assert.equal(resolved.source, "model")
  assert.equal(resolved.selector, "claude-agent/claude-opus-5")
  assert.deepEqual(resolved.permissions, [])
  assert.deepEqual(resolved.limits, {})
})

test("agent assignment wins over default when no exact model override exists", () => {
  const policy = basePolicy()
  policy.agents.router = {
    profile: "restricted",
    permissions: denyBash,
    limits: { max_steps: 12 },
  }

  const resolved = resolveExecutionPolicy(policy, {
    agent: "router",
    providerID: "zai-coding-plan",
    modelID: "glm-5.2",
  })

  assert.equal(resolved.profile, "restricted")
  assert.equal(resolved.source, "agent")
  assert.equal(resolved.selector, "router")
  assert.deepEqual(resolved.permissions, denyBash)
  assert.deepEqual(resolved.limits, {
    max_steps: 12,
    max_tool_calls: 80,
    max_child_depth: 1,
  })
})

test("explicit session override may widen the effective policy", () => {
  const resolved = resolveExecutionPolicy(basePolicy(), {
    agent: "router",
    providerID: "openai",
    modelID: "gpt-5.6-sol",
    sessionOverride: {
      profile: "full",
      limits: { max_steps: 200 },
    },
  })

  assert.equal(resolved.profile, "full")
  assert.equal(resolved.source, "session")
  assert.equal(resolved.selector, "explicit")
  assert.deepEqual(resolved.permissions, allowAll)
  assert.deepEqual(resolved.limits, { max_steps: 200 })
})

test("native adds no permission rules while full explicitly allows the wildcard", () => {
  const policy = basePolicy()
  const native = resolveExecutionPolicy(policy, {
    agent: "claude",
    providerID: "claude-agent",
    modelID: "claude-opus-5",
  })
  const full = resolveExecutionPolicy(policy, {
    agent: "unknown",
    providerID: "unknown",
    modelID: "unknown",
    sessionOverride: "full",
  })

  assert.deepEqual(native.permissions, [])
  assert.deepEqual(full.permissions, allowAll)
})

test("loads defaults, optional global config and optional project config from disk", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-router-policy-"))
  const defaultsPath = join(directory, "defaults.json")
  const globalPath = join(directory, "global.json")
  const projectPath = join(directory, "project.json")
  await writeFile(defaultsPath, JSON.stringify(basePolicy()))
  await writeFile(globalPath, JSON.stringify({ agents: { router: "full" } }))
  await writeFile(projectPath, JSON.stringify({ agents: { router: "restricted" } }))

  const loaded = await loadExecutionPolicy({ defaultsPath, globalPath, projectPath })

  assert.deepEqual(loaded.agents.router, { profile: "restricted" })
})

test("shipped defaults keep every model native until the user opts into restrictions", async () => {
  const loaded = await loadExecutionPolicy()

  assert.equal(loaded.defaultProfile, "native")
  assert.ok(Object.values(loaded.agents).every(({ profile }) => profile === "native"))
  assert.ok(Object.values(loaded.models).every(({ profile }) => profile === "native"))
})

test("missing optional config files are ignored and malformed JSON names its source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-router-policy-"))
  const defaultsPath = join(directory, "defaults.json")
  const malformedPath = join(directory, "malformed.json")
  await writeFile(defaultsPath, JSON.stringify(basePolicy()))
  await writeFile(malformedPath, "{")

  const loaded = await loadExecutionPolicy({
    defaultsPath,
    globalPath: join(directory, "missing-global.json"),
    projectPath: join(directory, "missing-project.json"),
  })
  assert.equal(loaded.defaultProfile, "restricted")

  await assert.rejects(
    loadExecutionPolicy({ defaultsPath, globalPath: malformedPath }),
    /malformed\.json.*valid JSON/,
  )
})
