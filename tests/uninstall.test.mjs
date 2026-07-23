import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { parse } from "jsonc-parser"

import { createOpenCodeUninstaller } from "../opencode/lib/uninstall.mjs"

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "llm-router-uninstall-"))
  await chmod(directory, 0o700)
  return realpath(directory)
}

async function put(root, relativePath, value, mode = 0o600) {
  const target = path.join(root, relativePath)
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await writeFile(target, value, { mode })
  await chmod(target, mode)
  return target
}

async function exists(target) {
  return lstat(target).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false
    throw error
  })
}

function tokenFrom(preview) {
  const match = preview.match(/\/router-uninstall ([A-Za-z0-9_-]+)/u)
  assert.ok(match, "preview must contain the confirmation command")
  return match[1]
}

async function trackedFixture() {
  const root = await fixture()
  const baselineDir = ".llm-router-backups/install/20260723"
  const originalConfig = `{
  // The user's provider must return after uninstall.
  "provider": {
    "keep": { "name": "keep" },
    "router-control": { "name": "previous" }
  },
  "command": { "keep": { "template": "keep" } },
  "agent": { "keep": { "model": "user/model" } }
}\n`
  const installedControl = { name: "Router control" }
  const installedCommand = {
    template: "Uninstall llm-router.",
    agent: "router-control",
  }
  const installedAgent = { model: "router-control/control" }
  const currentConfig = `{
  // Keep this comment and unrelated configuration.
  "provider": {
    "keep": { "name": "keep" },
    "router-control": { "name": "Router control" }
  },
  "command": {
    "keep": { "template": "keep" },
    "router-uninstall": {
      "template": "Uninstall llm-router.",
      "agent": "router-control"
    }
  },
  "agent": {
    "keep": { "model": "user/model" },
    "router": { "model": "user/changed-after-install" }
  }
}\n`
  const originalPackage = `{
  "private": true,
  "dependencies": {
    "router-package": "0.9.0",
    "keep": "7.0.0"
  }
}\n`
  const currentPackage = `{
  "private": true,
  "dependencies": {
    "router-package": "1.0.0",
    "created-package": "2.0.0",
    "changed-package": "9.0.0",
    "keep": "7.0.0"
  }
}\n`
  const createdPlugin = "export const installed = true\n"
  const installedLibrary = "export const version = 2\n"
  const originalLibrary = "export const version = 1\n"

  await put(root, "opencode.jsonc", currentConfig, 0o640)
  await put(root, "package.json", currentPackage, 0o640)
  await put(root, "plugins/llm_router_handoff.ts", createdPlugin)
  await put(root, "lib/direct_handoff.mjs", installedLibrary)
  await put(root, "llm-router.policy.json", '{"defaultProfile":"full"}\n')
  await put(root, `${baselineDir}/shared/opencode.jsonc`, originalConfig)
  await put(root, `${baselineDir}/shared/package.json`, originalPackage)
  await put(root, `${baselineDir}/managed/lib/direct_handoff.mjs`, originalLibrary)

  const state = {
    schemaVersion: 1,
    status: "installed",
    legacy: false,
    configDir: root,
    baselineDir,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    sharedBaselines: {
      opencode: {
        relativePath: "opencode.jsonc",
        existed: true,
        originalSha256: sha256(originalConfig),
        backupPath: "shared/opencode.jsonc",
      },
      package: {
        relativePath: "package.json",
        existed: true,
        originalSha256: sha256(originalPackage),
        backupPath: "shared/package.json",
      },
    },
    managedConfig: [
      {
        path: ["provider", "router-control"],
        installedValue: installedControl,
        original: {
          known: true,
          existed: true,
          value: { name: "previous" },
        },
      },
      {
        path: ["command", "router-uninstall"],
        installedValue: installedCommand,
        original: { known: true, existed: false },
      },
      {
        path: ["agent", "router"],
        installedValue: installedAgent,
        original: { known: true, existed: false },
      },
    ],
    managedDependencies: [
      {
        name: "router-package",
        installedValue: "1.0.0",
        original: { known: true, existed: true, value: "0.9.0" },
      },
      {
        name: "created-package",
        installedValue: "2.0.0",
        original: { known: true, existed: false },
      },
      {
        name: "changed-package",
        installedValue: "3.0.0",
        original: { known: true, existed: false },
      },
    ],
    managedFiles: [
      {
        relativePath: "plugins/llm_router_handoff.ts",
        ownership: "created",
        installedSha256: sha256(createdPlugin),
        original: {
          known: true,
          existed: false,
          sha256: null,
          backupPath: null,
        },
      },
      {
        relativePath: "lib/direct_handoff.mjs",
        ownership: "replaced",
        installedSha256: sha256(installedLibrary),
        original: {
          known: true,
          existed: true,
          sha256: sha256(originalLibrary),
          backupPath: "managed/lib/direct_handoff.mjs",
        },
      },
    ],
  }
  await put(root, "llm-router.install-state.json", `${JSON.stringify(state, null, 2)}\n`)
  return {
    currentConfig,
    currentPackage,
    originalLibrary,
    root,
  }
}

test("tracked uninstall previews without mutation and restores only unchanged managed values", async () => {
  const setup = await trackedFixture()
  const moves = []
  const uninstaller = await createOpenCodeUninstaller({
    configDir: setup.root,
    now: () => new Date("2026-07-23T12:34:56.789Z"),
    renamePath: async (source, destination) => {
      moves.push([source, destination])
      return rename(source, destination)
    },
    tokenFactory: () => "tracked-confirmation-token",
  })

  const preview = await uninstaller.execute("")
  assert.match(preview, /tracked state/u)
  assert.match(preview, /write opencode\.jsonc: provider\.router-control, command\.router-uninstall/u)
  assert.match(preview, /write package\.json: dependencies\.router-package/u)
  assert.match(preview, /move plugins\/llm_router_handoff\.ts/u)
  assert.match(preview, /Preserved:\n- llm-router\.policy\.json/u)
  assert.equal(await readFile(path.join(setup.root, "opencode.jsonc"), "utf8"), setup.currentConfig)
  assert.equal(moves.length, 0)

  const result = await uninstaller.execute(tokenFrom(preview))
  const configSource = await readFile(path.join(setup.root, "opencode.jsonc"), "utf8")
  const config = parse(configSource)
  const packageJson = JSON.parse(
    await readFile(path.join(setup.root, "package.json"), "utf8"),
  )

  assert.match(configSource, /Keep this comment/u)
  assert.deepEqual(config.provider["router-control"], { name: "previous" })
  assert.equal(config.command["router-uninstall"], undefined)
  assert.deepEqual(config.agent.router, { model: "user/changed-after-install" })
  assert.equal(packageJson.dependencies["router-package"], "0.9.0")
  assert.equal(packageJson.dependencies["created-package"], undefined)
  assert.equal(packageJson.dependencies["changed-package"], "9.0.0")
  assert.equal(packageJson.dependencies.keep, "7.0.0")
  assert.equal(
    await readFile(path.join(setup.root, "lib/direct_handoff.mjs"), "utf8"),
    setup.originalLibrary,
  )
  assert.equal(
    await exists(path.join(setup.root, "plugins/llm_router_handoff.ts")),
    false,
  )
  assert.equal(
    await readFile(path.join(setup.root, "llm-router.policy.json"), "utf8"),
    '{"defaultProfile":"full"}\n',
  )
  assert.equal(
    await exists(path.join(setup.root, "llm-router.install-state.json")),
    false,
  )
  assert.match(result, /without calling an LLM/u)
  assert.match(result, /Restart OpenCode/u)

  const stateMove = moves.findIndex(([source]) => source.endsWith("llm-router.install-state.json"))
  const pluginMove = moves.findIndex(([source]) => source.endsWith("plugins/llm_router_handoff.ts"))
  const libraryMove = moves.findIndex(([source]) => source.endsWith("lib/direct_handoff.mjs"))
  assert.ok(libraryMove >= 0 && pluginMove > libraryMove && stateMove > pluginMove)

  const backupMatch = result.match(/Recovery backup: (.+)/u)
  assert.ok(backupMatch)
  const backupInfo = await lstat(backupMatch[1])
  const backedConfig = await lstat(path.join(backupMatch[1], "shared/opencode.jsonc"))
  assert.equal(backupInfo.mode & 0o777, 0o700)
  assert.equal(backedConfig.mode & 0o777, 0o600)

  await assert.rejects(
    uninstaller.execute("tracked-confirmation-token"),
    /confirmation token is invalid/u,
  )
})

test("fingerprint mismatch fails before any uninstall mutation", async () => {
  const setup = await trackedFixture()
  const uninstaller = await createOpenCodeUninstaller({
    configDir: setup.root,
    tokenFactory: () => "stale-confirmation-token",
  })
  const preview = await uninstaller.execute("")
  await put(
    setup.root,
    "opencode.jsonc",
    setup.currentConfig.replace('"keep"', '"changed-by-user"'),
    0o640,
  )

  await assert.rejects(
    uninstaller.execute(tokenFrom(preview)),
    /configuration changed after preview/u,
  )
  assert.equal(
    await exists(path.join(setup.root, "plugins/llm_router_handoff.ts")),
    true,
  )
  assert.equal(
    await exists(path.join(setup.root, ".llm-router-backups/uninstall")),
    false,
  )
})

test("a package created by the installer is moved when only template fields remain", async () => {
  const setup = await trackedFixture()
  const statePath = path.join(setup.root, "llm-router.install-state.json")
  const state = JSON.parse(await readFile(statePath, "utf8"))
  state.sharedBaselines.package = {
    relativePath: "package.json",
    existed: false,
    originalSha256: null,
    backupPath: null,
  }
  state.managedDependencies = state.managedDependencies.filter(
    ({ name }) => name !== "changed-package",
  ).map((entry) => ({
    ...entry,
    original: { known: true, existed: false },
  }))
  await put(
    setup.root,
    "package.json",
    '{"private":true,"dependencies":{"router-package":"1.0.0","created-package":"2.0.0"}}\n',
    0o640,
  )
  await put(setup.root, "llm-router.install-state.json", `${JSON.stringify(state, null, 2)}\n`)
  const uninstaller = await createOpenCodeUninstaller({
    configDir: setup.root,
    tokenFactory: () => "created-package-token",
  })

  const preview = await uninstaller.execute("")
  assert.match(preview, /move package\.json/u)
  const result = await uninstaller.execute(tokenFrom(preview))
  assert.equal(await exists(path.join(setup.root, "package.json")), false)
  const recoveryMatch = result.match(/Recovery backup: (.+)/u)
  assert.ok(recoveryMatch)
  assert.equal(
    await readFile(path.join(recoveryMatch[1], "shared/package.json"), "utf8"),
    '{"private":true,"dependencies":{"router-package":"1.0.0","created-package":"2.0.0"}}\n',
  )
})

test("missing install state uses a conservative legacy fallback", async () => {
  const root = await fixture()
  const packageSource = '{"dependencies":{"@opencode-ai/plugin":"1.18.4","keep":"1.0.0"}}\n'
  await put(root, "opencode.jsonc", `{
    "provider": {
      "router-control": { "npm": "router" },
      "claude-agent": { "npm": "user" }
    },
    "command": {
      "router-status": { "template": "status" },
      "keep": { "template": "keep" }
    },
    "agent": {
      "router": { "model": "router-control/control" },
      "glm": { "model": "user/glm" }
    }
  }\n`)
  await put(root, "package.json", packageSource)
  await put(root, "plugins/llm_router_handoff.ts", "router plugin\n")
  await put(root, "providers/router_control_provider.mjs", "router provider\n")
  await put(root, "providers/claude_agent_provider.mjs", "user provider\n")
  await put(root, "llm-router.policy.json", '{"user":true}\n')

  const uninstaller = await createOpenCodeUninstaller({
    configDir: root,
    tokenFactory: () => "legacy-confirmation-token",
  })
  const preview = await uninstaller.execute("")
  assert.match(preview, /legacy state/u)
  assert.match(preview, /opencode\.jsonc:provider\.router-control/u)
  assert.match(preview, /opencode\.jsonc:provider\.claude-agent/u)
  assert.match(preview, /opencode\.jsonc:command\.router-status/u)
  assert.match(preview, /opencode\.jsonc:agent\.router/u)
  assert.match(preview, /opencode\.jsonc:agent\.glm/u)
  assert.match(preview, /package\.json:dependencies\.@opencode-ai\/plugin/u)
  assert.match(preview, /plugins\/llm_router_handoff\.ts/u)
  assert.match(preview, /providers\/claude_agent_provider\.mjs/u)
  assert.match(preview, /providers\/router_control_provider\.mjs/u)
  const result = await uninstaller.execute(tokenFrom(preview))

  const config = parse(await readFile(path.join(root, "opencode.jsonc"), "utf8"))
  assert.deepEqual(config.provider["router-control"], { npm: "router" })
  assert.deepEqual(config.provider["claude-agent"], { npm: "user" })
  assert.deepEqual(config.command["router-status"], { template: "status" })
  assert.deepEqual(config.command.keep, { template: "keep" })
  assert.deepEqual(config.agent.router, { model: "router-control/control" })
  assert.deepEqual(config.agent.glm, { model: "user/glm" })
  assert.equal(await readFile(path.join(root, "package.json"), "utf8"), packageSource)
  assert.equal(
    await readFile(path.join(root, "plugins/llm_router_handoff.ts"), "utf8"),
    "router plugin\n",
  )
  assert.equal(
    await readFile(path.join(root, "providers/router_control_provider.mjs"), "utf8"),
    "router provider\n",
  )
  assert.equal(
    await exists(path.join(root, "providers/claude_agent_provider.mjs")),
    true,
  )
  assert.equal(await readFile(path.join(root, "llm-router.policy.json"), "utf8"), '{"user":true}\n')
  assert.match(result, /No automatic changes were applied/u)
  assert.doesNotMatch(result, /Recovery backup:/u)
})

test("legacy install state honors known ownership and preserves unknown files", async () => {
  const root = await fixture()
  const baselineDir = ".llm-router-backups/install/legacy"
  const createdPlugin = "router plugin\n"
  const installedLibrary = "installed library\n"
  const originalLibrary = "original library\n"
  const unknownProvider = "unknown provider\n"
  await put(root, "opencode.jsonc", '{"command":{}}\n')
  await put(root, "package.json", '{"dependencies":{}}\n')
  await put(root, "plugins/llm_router_handoff.ts", createdPlugin)
  await put(root, "lib/direct_handoff.mjs", installedLibrary)
  await put(root, "providers/claude_agent_provider.mjs", unknownProvider)
  await put(
    root,
    `${baselineDir}/managed/lib/direct_handoff.mjs`,
    originalLibrary,
  )
  const state = {
    schemaVersion: 1,
    status: "installed",
    legacy: true,
    configDir: root,
    baselineDir,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    sharedBaselines: {
      opencode: {
        relativePath: "opencode.jsonc",
        existed: false,
        originalSha256: null,
        backupPath: null,
      },
      package: {
        relativePath: "package.json",
        existed: false,
        originalSha256: null,
        backupPath: null,
      },
    },
    managedConfig: [],
    managedDependencies: [],
    managedFiles: [
      {
        relativePath: "plugins/llm_router_handoff.ts",
        ownership: "created",
        installedSha256: sha256(createdPlugin),
        original: {
          known: true,
          existed: false,
          sha256: null,
          backupPath: null,
        },
      },
      {
        relativePath: "lib/direct_handoff.mjs",
        ownership: "replaced",
        installedSha256: sha256(installedLibrary),
        original: {
          known: true,
          existed: true,
          sha256: sha256(originalLibrary),
          backupPath: "managed/lib/direct_handoff.mjs",
        },
      },
      {
        relativePath: "providers/claude_agent_provider.mjs",
        ownership: "legacy",
        installedSha256: sha256(unknownProvider),
        original: {
          known: false,
          existed: false,
          sha256: null,
          backupPath: null,
        },
      },
    ],
  }
  await put(
    root,
    "llm-router.install-state.json",
    `${JSON.stringify(state, null, 2)}\n`,
  )

  const uninstaller = await createOpenCodeUninstaller({
    configDir: root,
    tokenFactory: () => "legacy-state-confirmation",
  })
  const preview = await uninstaller.execute("")
  assert.match(preview, /Preserved:\n- llm-router\.policy\.json\n- providers\/claude_agent_provider\.mjs/u)
  await uninstaller.execute(tokenFrom(preview))

  assert.equal(
    await exists(path.join(root, "plugins/llm_router_handoff.ts")),
    false,
  )
  assert.equal(
    await readFile(path.join(root, "lib/direct_handoff.mjs"), "utf8"),
    originalLibrary,
  )
  assert.equal(
    await readFile(path.join(root, "providers/claude_agent_provider.mjs"), "utf8"),
    unknownProvider,
  )
  assert.equal(
    await exists(path.join(root, "llm-router.install-state.json")),
    false,
  )
})

test("unsafe managed paths and symbolic links fail during preview", async (context) => {
  await context.test("state path traversal", async () => {
    const setup = await trackedFixture()
    const statePath = path.join(setup.root, "llm-router.install-state.json")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    state.managedFiles[0].relativePath = "../outside"
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    const uninstaller = await createOpenCodeUninstaller({ configDir: setup.root })
    await assert.rejects(uninstaller.execute(""), /escapes its allowed directory/u)
  })

  await context.test("managed symbolic link", async () => {
    const setup = await trackedFixture()
    const plugin = path.join(setup.root, "plugins/llm_router_handoff.ts")
    const displaced = path.join(setup.root, "plugins/original-plugin.ts")
    await rename(plugin, displaced)
    await symlink(displaced, plugin)
    const uninstaller = await createOpenCodeUninstaller({ configDir: setup.root })
    await assert.rejects(uninstaller.execute(""), /refusing symbolic link/u)
  })

  await context.test("prepared state", async () => {
    const setup = await trackedFixture()
    const statePath = path.join(setup.root, "llm-router.install-state.json")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    state.status = "prepared"
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    const uninstaller = await createOpenCodeUninstaller({ configDir: setup.root })
    await assert.rejects(
      uninstaller.execute(""),
      /status must be installed before uninstall/u,
    )
  })

  await context.test("public state permissions", async () => {
    const setup = await trackedFixture()
    await chmod(path.join(setup.root, "llm-router.install-state.json"), 0o644)
    const uninstaller = await createOpenCodeUninstaller({ configDir: setup.root })
    await assert.rejects(uninstaller.execute(""), /must have mode 0600/u)
  })

  await context.test("legacy state for another config directory", async () => {
    const setup = await trackedFixture()
    const statePath = path.join(setup.root, "llm-router.install-state.json")
    const state = JSON.parse(await readFile(statePath, "utf8"))
    state.legacy = true
    state.configDir = "/different/opencode"
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    const uninstaller = await createOpenCodeUninstaller({ configDir: setup.root })
    await assert.rejects(
      uninstaller.execute(""),
      /does not match the active configuration directory/u,
    )
  })
})

test("failure after a shared edit restores the active configuration", async () => {
  const setup = await trackedFixture()
  let failed = false
  const uninstaller = await createOpenCodeUninstaller({
    configDir: setup.root,
    renamePath: async (source, destination) => {
      if (
        !failed
        && source.endsWith("plugins/llm_router_handoff.ts")
        && destination.includes(`${path.sep}removed${path.sep}`)
      ) {
        failed = true
        throw new Error("injected move failure")
      }
      return rename(source, destination)
    },
    tokenFactory: () => "rollback-confirmation-token",
  })

  const preview = await uninstaller.execute("")
  await assert.rejects(uninstaller.execute(tokenFrom(preview)), /injected move failure/u)
  assert.equal(
    await readFile(path.join(setup.root, "opencode.jsonc"), "utf8"),
    setup.currentConfig,
  )
  assert.equal(
    await exists(path.join(setup.root, "plugins/llm_router_handoff.ts")),
    true,
  )
  assert.equal(
    await exists(path.join(setup.root, "llm-router.install-state.json")),
    true,
  )
})

test("post-rename permission failure rolls back a root-level file", async () => {
  const setup = await trackedFixture()
  let failed = false
  const uninstaller = await createOpenCodeUninstaller({
    chmodMovedPath: async (target, mode) => {
      if (!failed && target.endsWith(`${path.sep}shared${path.sep}opencode.jsonc`)) {
        failed = true
        throw new Error("injected permission failure")
      }
      return chmod(target, mode)
    },
    configDir: setup.root,
    tokenFactory: () => "permission-failure-token",
  })

  const preview = await uninstaller.execute("")
  await assert.rejects(
    uninstaller.execute(tokenFrom(preview)),
    /injected permission failure/u,
  )
  assert.equal(
    await readFile(path.join(setup.root, "opencode.jsonc"), "utf8"),
    setup.currentConfig,
  )
  assert.equal(
    await exists(path.join(setup.root, "llm-router.install-state.json")),
    true,
  )
})

test("a concurrent edit is preserved and never overwritten", async () => {
  const setup = await trackedFixture()
  const concurrentConfig = setup.currentConfig.replace(
    "Keep this comment",
    "Concurrent user edit",
  )
  let injected = false
  const uninstaller = await createOpenCodeUninstaller({
    configDir: setup.root,
    renamePath: async (source, destination) => {
      if (
        !injected
        && source.endsWith("opencode.jsonc")
        && destination.includes(`${path.sep}shared${path.sep}`)
      ) {
        injected = true
        await writeFile(source, concurrentConfig)
      }
      return rename(source, destination)
    },
    tokenFactory: () => "concurrent-edit-token",
  })

  const preview = await uninstaller.execute("")
  let error
  try {
    await uninstaller.execute(tokenFrom(preview))
    assert.fail("concurrent mutation must abort uninstall")
  } catch (caught) {
    error = caught
  }
  assert.match(error.message, /changed while uninstall was being applied/u)
  assert.equal(
    await readFile(path.join(setup.root, "opencode.jsonc"), "utf8"),
    setup.currentConfig,
  )
  const recoveryMatch = error.message.match(/recovery is in ([^:]+):/u)
  assert.ok(recoveryMatch)
  assert.equal(
    await readFile(path.join(recoveryMatch[1], "shared/opencode.jsonc"), "utf8"),
    concurrentConfig,
  )
})
