import { createHash, randomBytes } from "node:crypto"
import {
  chmod,
  constants,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rename,
} from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import path from "node:path"

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser"

const STATE_FILE = "llm-router.install-state.json"
const POLICY_FILE = "llm-router.policy.json"
const SHARED_FILES = new Set(["opencode.jsonc", "package.json"])
const TOKEN_TTL_MS = 10 * 60 * 1000
const HASH_PATTERN = /^[a-f0-9]{64}$/u

const LEGACY_FILES = [
  "lib/adaptive_routing.mjs",
  "lib/claude_agent.mjs",
  "lib/claude_checkpoint.mjs",
  "lib/claude_context.mjs",
  "lib/direct_handoff.mjs",
  "lib/execution_policy.mjs",
  "lib/install_state.mjs",
  "lib/opencode_transport.mjs",
  "lib/repo_query.mjs",
  "lib/route_contract.mjs",
  "lib/route_manifest.mjs",
  "lib/router_control.mjs",
  "lib/routing_policy.mjs",
  "lib/session_metadata.mjs",
  "lib/uninstall.mjs",
  "plugins/llm_router_handoff.ts",
  "providers/claude_agent_provider.mjs",
  "providers/router_control_provider.mjs",
  "llm-router.policy.defaults.json",
  "llm-router.policy.schema.json",
  "tools/repo_query.ts",
]
const LEGACY_AGENTS = new Set([
  "claude",
  "codex",
  "glm",
  "minimax",
  "router",
  "router-adaptive",
  "router-auto",
  "router-control",
  "router-manual",
])
const LEGACY_DEPENDENCIES = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
  "jsonc-parser",
])
const LEGACY_PROVIDERS = new Set(["claude-agent", "router-control"])

function fail(message) {
  throw new Error(`llm-router uninstall: ${message}`)
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function parseObject(source, label) {
  const errors = []
  const value = parse(source, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0) {
    const first = errors[0]
    fail(
      `${label} is invalid JSONC at offset ${first.offset}: `
      + printParseErrorCode(first.error),
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must contain an object`)
  }
  return value
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function lookup(value, propertyPath) {
  let cursor = value
  for (const segment of propertyPath) {
    if (
      !cursor
      || typeof cursor !== "object"
      || Array.isArray(cursor)
      || !hasOwn(cursor, segment)
    ) {
      return { exists: false, value: undefined }
    }
    cursor = cursor[segment]
  }
  return { exists: true, value: cursor }
}

function normalizedRelativePath(value, label) {
  if (
    typeof value !== "string"
    || value.length === 0
    || path.isAbsolute(value)
    || value.includes("\\")
    || value.includes("\0")
  ) {
    fail(`${label} must be a safe relative POSIX path`)
  }
  const normalized = path.posix.normalize(value)
  if (
    normalized !== value
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
  ) {
    fail(`${label} escapes its allowed directory`)
  }
  return normalized
}

function assertHash(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    fail(`${label} must contain a lowercase SHA-256 digest`)
  }
}

function assertOwned(statValue, label, getUid) {
  const uid = getUid()
  if (uid !== null && statValue.uid !== uid) {
    fail(`${label} must be owned by the current user`)
  }
}

async function inspectRoot(configDir, getUid) {
  if (typeof configDir !== "string" || configDir.length === 0) {
    fail("configDir is required")
  }
  const resolved = path.resolve(configDir)
  const info = await lstat(resolved).catch((error) => {
    if (error?.code === "ENOENT") fail(`configuration directory does not exist: ${resolved}`)
    throw error
  })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`configuration directory must be a real directory: ${resolved}`)
  }
  assertOwned(info, "configuration directory", getUid)
  const canonical = await realpath(resolved)
  if (canonical !== resolved) {
    fail(`configuration directory may not contain symbolic-link components: ${resolved}`)
  }
  return resolved
}

async function inspectRelativePath(root, relativePath, getUid, leafKind = "file") {
  const normalized = normalizedRelativePath(relativePath, "managed path")
  let cursor = root
  const segments = normalized.split("/")
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index])
    const info = await lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!info) return { exists: false, path: path.join(root, normalized) }
    if (info.isSymbolicLink()) {
      fail(`refusing symbolic link: ${cursor}`)
    }
    assertOwned(info, cursor, getUid)
    const atLeaf = index === segments.length - 1
    if (!atLeaf && !info.isDirectory()) {
      fail(`managed path parent is not a directory: ${cursor}`)
    }
    if (
      atLeaf
      && (
        (leafKind === "file" && !info.isFile())
        || (leafKind === "directory" && !info.isDirectory())
      )
    ) {
      fail(`managed path has the wrong type: ${cursor}`)
    }
  }
  return {
    exists: true,
    path: path.join(root, normalized),
  }
}

async function readOwnedFile(root, relativePath, getUid, { optional = false } = {}) {
  const inspected = await inspectRelativePath(root, relativePath, getUid)
  if (!inspected.exists) {
    if (optional) return null
    fail(`required file is missing: ${inspected.path}`)
  }
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(inspected.path, constants.O_RDONLY | noFollow)
  try {
    const info = await handle.stat()
    if (!info.isFile()) fail(`managed path is not a regular file: ${inspected.path}`)
    assertOwned(info, inspected.path, getUid)
    const bytes = await handle.readFile()
    return {
      bytes,
      hash: sha256(bytes),
      mode: info.mode & 0o777,
      path: inspected.path,
      relativePath,
    }
  } finally {
    await handle.close()
  }
}

function parseState(bytes) {
  let state
  try {
    state = JSON.parse(bytes.toString("utf8"))
  } catch {
    fail(`${STATE_FILE} must contain valid JSON`)
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    fail(`${STATE_FILE} must contain an object`)
  }
  if (state.schemaVersion !== 1) fail(`${STATE_FILE} has an unsupported schemaVersion`)
  if (!["prepared", "installed"].includes(state.status)) {
    fail(`${STATE_FILE}.status must be prepared or installed`)
  }
  if (typeof state.legacy !== "boolean") fail(`${STATE_FILE}.legacy must be boolean`)
  if (typeof state.configDir !== "string" || !path.isAbsolute(state.configDir)) {
    fail(`${STATE_FILE}.configDir must be absolute`)
  }
  const baselineDir = normalizedRelativePath(
    state.baselineDir,
    `${STATE_FILE}.baselineDir`,
  )
  if (!baselineDir.startsWith(".llm-router-backups/install/")) {
    fail(`${STATE_FILE}.baselineDir must be inside .llm-router-backups/install/`)
  }
  if (!state.sharedBaselines || typeof state.sharedBaselines !== "object") {
    fail(`${STATE_FILE}.sharedBaselines must contain an object`)
  }
  for (const key of ["opencode", "package"]) {
    const baseline = state.sharedBaselines[key]
    if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
      fail(`${STATE_FILE}.sharedBaselines.${key} must contain an object`)
    }
    const expectedPath = key === "opencode" ? "opencode.jsonc" : "package.json"
    if (baseline.relativePath !== expectedPath) {
      fail(`${STATE_FILE}.sharedBaselines.${key}.relativePath must be ${expectedPath}`)
    }
    if (typeof baseline.existed !== "boolean") {
      fail(`${STATE_FILE}.sharedBaselines.${key}.existed must be boolean`)
    }
    assertHash(
      baseline.originalSha256,
      `${STATE_FILE}.sharedBaselines.${key}.originalSha256`,
      { nullable: true },
    )
    if (baseline.existed) {
      normalizedRelativePath(
        baseline.backupPath,
        `${STATE_FILE}.sharedBaselines.${key}.backupPath`,
      )
      if (baseline.originalSha256 === null) {
        fail(`${STATE_FILE}.sharedBaselines.${key} is missing its original hash`)
      }
    } else if (baseline.backupPath !== null || baseline.originalSha256 !== null) {
      fail(`${STATE_FILE}.sharedBaselines.${key} has a baseline for an absent file`)
    }
  }
  if (!Array.isArray(state.managedConfig)) {
    fail(`${STATE_FILE}.managedConfig must be an array`)
  }
  if (!Array.isArray(state.managedDependencies)) {
    fail(`${STATE_FILE}.managedDependencies must be an array`)
  }
  if (!Array.isArray(state.managedFiles)) {
    fail(`${STATE_FILE}.managedFiles must be an array`)
  }
  validateManagedConfig(state.managedConfig)
  validateManagedDependencies(state.managedDependencies)
  validateManagedFiles(state.managedFiles)
  for (const [key, record] of Object.entries(state.sharedBaselines)) {
    if (record.existed && !record.backupPath.startsWith("shared/")) {
      fail(`${STATE_FILE}.sharedBaselines.${key}.backupPath must be inside shared/`)
    }
  }
  state.managedFiles.forEach((record, index) => {
    if (
      record.original.known
      && record.original.existed
      && !record.original.backupPath.startsWith("managed/")
    ) {
      fail(
        `${STATE_FILE}.managedFiles[${index}].original.backupPath `
        + "must be inside managed/",
      )
    }
  })
  return state
}

function validateOriginal(original, label) {
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    fail(`${label}.original must contain an object`)
  }
  if (typeof original.known !== "boolean" || typeof original.existed !== "boolean") {
    fail(`${label}.original must declare known and existed`)
  }
  if (!original.known && original.existed) {
    fail(`${label}.original cannot exist when its value is unknown`)
  }
  if (original.known && original.existed && !hasOwn(original, "value")) {
    fail(`${label}.original is missing value`)
  }
}

function validateManagedConfig(entries) {
  const paths = new Set()
  entries.forEach((entry, index) => {
    const label = `${STATE_FILE}.managedConfig[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${label} must contain an object`)
    }
    if (
      !Array.isArray(entry.path)
      || entry.path.length === 0
      || entry.path.some(
        (segment) => (
          typeof segment !== "string"
          || segment.length === 0
          || ["__proto__", "constructor", "prototype"].includes(segment)
        ),
      )
    ) {
      fail(`${label}.path must be a non-empty string array`)
    }
    if (!hasOwn(entry, "installedValue")) fail(`${label} is missing installedValue`)
    validateOriginal(entry.original, label)
    const key = JSON.stringify(entry.path)
    if (paths.has(key)) fail(`${label}.path is duplicated`)
    paths.add(key)
  })
}

function validateManagedDependencies(entries) {
  const names = new Set()
  entries.forEach((entry, index) => {
    const label = `${STATE_FILE}.managedDependencies[${index}]`
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || typeof entry.name !== "string"
      || entry.name.length === 0
      || typeof entry.installedValue !== "string"
    ) {
      fail(`${label} has an invalid dependency record`)
    }
    validateOriginal(entry.original, label)
    if (
      entry.original.known
      && entry.original.existed
      && typeof entry.original.value !== "string"
    ) {
      fail(`${label}.original.value must be a string`)
    }
    if (names.has(entry.name)) fail(`${label}.name is duplicated`)
    names.add(entry.name)
  })
}

function validateManagedFiles(entries) {
  const files = new Set()
  entries.forEach((entry, index) => {
    const label = `${STATE_FILE}.managedFiles[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${label} must contain an object`)
    }
    const relativePath = normalizedRelativePath(entry.relativePath, `${label}.relativePath`)
    if (relativePath === POLICY_FILE) fail(`${POLICY_FILE} may not be managed by uninstall`)
    if (relativePath === STATE_FILE || SHARED_FILES.has(relativePath)) {
      fail(`${label}.relativePath conflicts with a reserved path`)
    }
    if (!["created", "replaced", "legacy"].includes(entry.ownership)) {
      fail(`${label}.ownership is invalid`)
    }
    assertHash(entry.installedSha256, `${label}.installedSha256`)
    if (!entry.original || typeof entry.original !== "object") {
      fail(`${label}.original must contain an object`)
    }
    const original = entry.original
    if (typeof original.known !== "boolean" || typeof original.existed !== "boolean") {
      fail(`${label}.original must declare known and existed`)
    }
    assertHash(original.sha256, `${label}.original.sha256`, { nullable: true })
    if (original.existed) {
      if (!original.known || original.sha256 === null) {
        fail(`${label}.original is missing a known hash`)
      }
      normalizedRelativePath(original.backupPath, `${label}.original.backupPath`)
    } else if (original.sha256 !== null || original.backupPath !== null) {
      fail(`${label}.original has backup data for an absent file`)
    }
    if (entry.ownership === "created" && (!original.known || original.existed)) {
      fail(`${label} has inconsistent ownership for a created file`)
    }
    if (entry.ownership === "replaced" && (!original.known || !original.existed)) {
      fail(`${label} has inconsistent ownership for a replaced file`)
    }
    if (files.has(relativePath)) fail(`${label}.relativePath is duplicated`)
    files.add(relativePath)
  })
}

function applyManagedValues(source, entries, label) {
  const current = parseObject(source, label)
  const formattingOptions = {
    eol: "\n",
    insertSpaces: true,
    tabSize: 2,
  }
  let next = source
  const preserved = []
  const changed = []
  for (const entry of entries) {
    const currentValue = lookup(current, entry.path)
    if (
      !entry.original.known
      || !currentValue.exists
      || !isDeepStrictEqual(currentValue.value, entry.installedValue)
    ) {
      if (currentValue.exists) preserved.push(entry.path.join("."))
      continue
    }
    const replacement = entry.original.existed ? entry.original.value : undefined
    next = applyEdits(
      next,
      modify(next, entry.path, replacement, { formattingOptions }),
    )
    changed.push(entry.path.join("."))
  }
  parseObject(next, `${label} after uninstall`)
  return { next, preserved, changed }
}

function applyManagedDependencies(source, entries) {
  return applyManagedValues(
    source,
    entries.map((entry) => ({
      ...entry,
      path: ["dependencies", entry.name],
    })),
    "package.json",
  )
}

function legacyConfigEntries(config) {
  const entries = []
  for (const key of Object.keys(config.command ?? {})) {
    if (key.startsWith("router-")) {
      entries.push({
        path: ["command", key],
        installedValue: config.command[key],
        original: { known: true, existed: false },
      })
    }
  }
  for (const key of Object.keys(config.agent ?? {})) {
    if (LEGACY_AGENTS.has(key)) {
      entries.push({
        path: ["agent", key],
        installedValue: config.agent[key],
        original: { known: true, existed: false },
      })
    }
  }
  for (const key of Object.keys(config.provider ?? {})) {
    if (LEGACY_PROVIDERS.has(key)) {
      entries.push({
        path: ["provider", key],
        installedValue: config.provider[key],
        original: { known: true, existed: false },
      })
    }
  }
  return entries
}

function legacyDependencyEntries(packageData) {
  return Object.keys(packageData.dependencies ?? {})
    .filter((name) => LEGACY_DEPENDENCIES.has(name))
    .sort()
    .map((name) => `package.json:dependencies.${name}`)
}

function isEmptyObjectTree(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every(
    (item) => item && typeof item === "object" && !Array.isArray(item)
      ? isEmptyObjectTree(item)
      : false,
  )
}

function isEmptyGeneratedPackage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const remaining = structuredClone(value)
  if (remaining.private === true) delete remaining.private
  if (
    remaining.dependencies
    && typeof remaining.dependencies === "object"
    && !Array.isArray(remaining.dependencies)
    && Object.keys(remaining.dependencies).length === 0
  ) {
    delete remaining.dependencies
  }
  return Object.keys(remaining).length === 0
}

async function validateBaseline(root, state, getUid) {
  const baselineDir = normalizedRelativePath(
    state.baselineDir,
    `${STATE_FILE}.baselineDir`,
  )
  const directory = await inspectRelativePath(root, baselineDir, getUid, "directory")
  if (!directory.exists) fail(`baseline directory is missing: ${directory.path}`)
  const directoryInfo = await lstat(directory.path)
  if ((directoryInfo.mode & 0o777) !== 0o700) {
    fail(`baseline directory must have mode 0700: ${directory.path}`)
  }
  const baselines = {}
  for (const [key, record] of Object.entries(state.sharedBaselines)) {
    if (!record.existed) {
      baselines[key] = null
      continue
    }
    const relativePath = path.posix.join(baselineDir, record.backupPath)
    const file = await readOwnedFile(root, relativePath, getUid)
    if (file.mode !== 0o600) {
      fail(`baseline file must have mode 0600: ${relativePath}`)
    }
    if (file.hash !== record.originalSha256) {
      fail(`baseline hash mismatch: ${relativePath}`)
    }
    baselines[key] = file
  }
  return { baselineDir, baselines }
}

function actionPriority(action) {
  if (action.relativePath === STATE_FILE) return 3
  if (
    action.relativePath.startsWith("plugins/")
    || action.relativePath.startsWith("providers/")
  ) {
    return 2
  }
  return 1
}

async function createPlan(root, getUid) {
  const stateFile = await readOwnedFile(root, STATE_FILE, getUid, { optional: true })
  const state = stateFile ? parseState(stateFile.bytes) : null
  const fresh = state && !state.legacy
  let baseline = null

  if (state) {
    if (path.resolve(state.configDir) !== root || state.configDir !== root) {
      fail(`${STATE_FILE}.configDir does not match the active configuration directory`)
    }
    if (state.status !== "installed") {
      fail(`${STATE_FILE}.status must be installed before uninstall`)
    }
    if (stateFile.mode !== 0o600) {
      fail(`${STATE_FILE} must have mode 0600`)
    }
  }

  if (state) {
    baseline = await validateBaseline(root, state, getUid)
  }

  const shared = []
  const preserved = [POLICY_FILE]
  const opencodeFile = await readOwnedFile(root, "opencode.jsonc", getUid, {
    optional: true,
  })
  if (opencodeFile) {
    const source = opencodeFile.bytes.toString("utf8")
    const currentConfig = parseObject(source, "opencode.jsonc")
    const entries = state ? state.managedConfig : []
    if (!state) {
      preserved.push(
        ...legacyConfigEntries(currentConfig)
          .map((entry) => `opencode.jsonc:${entry.path.join(".")}`),
      )
    }
    const result = applyManagedValues(source, entries, "opencode.jsonc")
    if (result.preserved.length > 0) {
      preserved.push(...result.preserved.map((item) => `opencode.jsonc:${item}`))
    }
    if (result.next !== source) {
      const parsedNext = parseObject(result.next, "opencode.jsonc after uninstall")
      shared.push({
        action: fresh
          && !state.sharedBaselines.opencode.existed
          && isEmptyObjectTree(parsedNext)
          ? "move"
          : "write",
        bytes: opencodeFile.bytes,
        changes: result.changed,
        currentHash: opencodeFile.hash,
        mode: opencodeFile.mode,
        nextBytes: Buffer.from(result.next),
        relativePath: "opencode.jsonc",
      })
    }
  }

  const packageFile = await readOwnedFile(root, "package.json", getUid, {
    optional: true,
  })
  if (packageFile && !state) {
    preserved.push(
      ...legacyDependencyEntries(parseObject(
        packageFile.bytes.toString("utf8"),
        "package.json",
      )),
    )
  }
  if (packageFile && state) {
    const source = packageFile.bytes.toString("utf8")
    const result = applyManagedDependencies(source, state.managedDependencies)
    if (result.preserved.length > 0) {
      preserved.push(...result.preserved.map((item) => `package.json:${item}`))
    }
    if (result.next !== source) {
      const parsedNext = parseObject(result.next, "package.json after uninstall")
      shared.push({
        action: !state.sharedBaselines.package.existed && isEmptyGeneratedPackage(parsedNext)
          ? "move"
          : "write",
        bytes: packageFile.bytes,
        changes: result.changed,
        currentHash: packageFile.hash,
        mode: packageFile.mode,
        nextBytes: Buffer.from(result.next),
        relativePath: "package.json",
      })
    }
  }

  const fileRecords = state
    ? state.managedFiles
    : LEGACY_FILES.map((relativePath) => ({
        relativePath,
        ownership: "legacy",
        installedSha256: null,
        original: { known: false, existed: false, sha256: null, backupPath: null },
      }))
  const files = []
  for (const record of fileRecords) {
    if (record.relativePath === POLICY_FILE) {
      preserved.push(record.relativePath)
      continue
    }
    const current = await readOwnedFile(root, record.relativePath, getUid, {
      optional: true,
    })
    if (!current) continue
    if (!state) {
      preserved.push(record.relativePath)
      continue
    }
    if (
      (
        record.ownership === "legacy"
        || !record.original.known
      )
    ) {
      preserved.push(record.relativePath)
      continue
    }
    let restore = null
    if (state && record.original.known && record.original.existed) {
      const backupRelativePath = path.posix.join(
        baseline.baselineDir,
        normalizedRelativePath(
          record.original.backupPath,
          `${record.relativePath}.original.backupPath`,
        ),
      )
      restore = await readOwnedFile(root, backupRelativePath, getUid)
      if (restore.mode !== 0o600) {
        fail(`baseline file must have mode 0600: ${backupRelativePath}`)
      }
      if (restore.hash !== record.original.sha256) {
        fail(`baseline hash mismatch: ${backupRelativePath}`)
      }
    }
    files.push({
      bytes: current.bytes,
      currentHash: current.hash,
      mode: current.mode,
      relativePath: record.relativePath,
      restore,
    })
  }

  if (stateFile) {
    files.push({
      bytes: stateFile.bytes,
      currentHash: stateFile.hash,
      mode: stateFile.mode,
      relativePath: STATE_FILE,
      restore: null,
    })
  }
  files.sort((left, right) => (
    actionPriority(left) - actionPriority(right)
    || left.relativePath.localeCompare(right.relativePath)
  ))

  const fingerprint = sha256(JSON.stringify({
    files: files.map((file) => ({
      currentHash: file.currentHash,
      currentMode: file.mode,
      relativePath: file.relativePath,
      restoreHash: file.restore?.hash ?? null,
    })),
    mode: fresh ? "tracked" : "legacy",
    shared: shared.map((file) => ({
      action: file.action,
      changes: file.changes,
      currentHash: file.currentHash,
      currentMode: file.mode,
      nextHash: sha256(file.nextBytes),
      relativePath: file.relativePath,
    })),
    stateHash: stateFile?.hash ?? null,
  }))

  return {
    files,
    fingerprint,
    mode: fresh ? "tracked" : "legacy",
    preserved: [...new Set(preserved)].sort(),
    shared,
  }
}

function timestamp(value) {
  return value.toISOString().replace(/\D/gu, "").slice(0, 17)
}

async function ensurePrivateDirectory(directory, root, getUid) {
  const relativePath = path.relative(root, directory).split(path.sep).join("/")
  await inspectRoot(root, getUid)
  if (relativePath === "") {
    return
  }
  const normalized = normalizedRelativePath(relativePath, "backup directory")
  let cursor = root
  const segments = normalized.split("/")
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index])
    let created = false
    let info = await lstat(cursor).catch((error) => {
      if (error?.code === "ENOENT") return null
      throw error
    })
    if (!info) {
      try {
        await mkdir(cursor, { mode: 0o700 })
        created = true
      } catch (error) {
        if (error?.code !== "EEXIST") throw error
      }
      info = await lstat(cursor)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`backup path must be a real directory: ${cursor}`)
    }
    assertOwned(info, cursor, getUid)
    if (created || index === segments.length - 1) await chmod(cursor, 0o700)
  }
}

async function createBackupDirectory(root, now, getUid) {
  const backupRoot = path.join(root, ".llm-router-backups", "uninstall")
  await ensurePrivateDirectory(backupRoot, root, getUid)
  const baseName = timestamp(now())
  for (let index = 0; index < 1000; index += 1) {
    const name = index === 0 ? baseName : `${baseName}-${index}`
    const candidate = path.join(backupRoot, name)
    try {
      await mkdir(candidate, { mode: 0o700 })
      await chmod(candidate, 0o700)
      return candidate
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
    }
  }
  fail("could not allocate a unique backup directory")
}

async function writePrivateBackup(backupDir, relativePath, bytes, getUid) {
  const destination = path.join(backupDir, relativePath)
  await ensurePrivateDirectory(path.dirname(destination), backupDir, getUid)
  const noFollow = constants.O_NOFOLLOW ?? 0
  const handle = await open(
    destination,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
    0o600,
  )
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
  return destination
}

async function atomicCreate(
  root,
  relativePath,
  bytes,
  mode,
  backupDir,
  linkPath,
  getUid,
) {
  const pendingRelative = path.posix.join(
    ".llm-router-backups",
    "uninstall",
    path.basename(backupDir),
    "pending",
    `${sha256(relativePath).slice(0, 16)}-${randomBytes(6).toString("hex")}.pending`,
  )
  const pendingPath = await writePrivateBackup(
    root,
    pendingRelative,
    bytes,
    getUid,
  )
  await chmod(pendingPath, mode)
  const target = path.join(root, relativePath)
  await ensurePrivateDirectory(path.dirname(target), root, getUid)
  await linkPath(pendingPath, target)
}

async function executePlan({
  chmodMovedPath,
  getUid,
  linkPath,
  now,
  plan,
  renamePath,
  root,
}) {
  if (plan.shared.length === 0 && plan.files.length === 0) return null
  const backupDir = await createBackupDirectory(root, now, getUid)
  const moved = []
  try {
    for (const item of plan.shared) {
      const current = await readOwnedFile(root, item.relativePath, getUid)
      if (current.hash !== item.currentHash || current.mode !== item.mode) {
        fail(`${item.relativePath} changed after confirmation`)
      }
      const destination = path.join(backupDir, "shared", item.relativePath)
      await ensurePrivateDirectory(path.dirname(destination), backupDir, getUid)
      await renamePath(current.path, destination)
      const movedRecord = {
        bytes: current.bytes,
        destination,
        mode: current.mode,
        relativePath: item.relativePath,
        restored: false,
      }
      moved.push(movedRecord)
      await chmodMovedPath(destination, 0o600)
      const captured = await readOwnedFile(
        root,
        path.relative(root, destination).split(path.sep).join("/"),
        getUid,
      )
      if (captured.hash !== item.currentHash) {
        fail(`${item.relativePath} changed while uninstall was being applied`)
      }
      if (item.action === "write") {
        await atomicCreate(
          root,
          item.relativePath,
          item.nextBytes,
          current.mode,
          backupDir,
          linkPath,
          getUid,
        )
        movedRecord.restored = true
      }
    }

    for (const item of plan.files) {
      const current = await readOwnedFile(root, item.relativePath, getUid)
      if (current.hash !== item.currentHash || current.mode !== item.mode) {
        fail(`${item.relativePath} changed after confirmation`)
      }
      const destination = path.join(backupDir, "removed", item.relativePath)
      await ensurePrivateDirectory(path.dirname(destination), backupDir, getUid)
      await renamePath(current.path, destination)
      const movedRecord = {
        bytes: current.bytes,
        destination,
        mode: current.mode,
        relativePath: item.relativePath,
        restored: false,
      }
      moved.push(movedRecord)
      await chmodMovedPath(destination, 0o600)
      const captured = await readOwnedFile(
        root,
        path.relative(root, destination).split(path.sep).join("/"),
        getUid,
      )
      if (captured.hash !== item.currentHash) {
        fail(`${item.relativePath} changed while uninstall was being applied`)
      }
      if (item.restore) {
        await atomicCreate(
          root,
          item.relativePath,
          item.restore.bytes,
          0o600,
          backupDir,
          linkPath,
          getUid,
        )
        movedRecord.restored = true
      }
    }
  } catch (error) {
    const rollbackErrors = []
    for (const item of [...moved].reverse()) {
      const target = path.join(root, item.relativePath)
      try {
        if (item.restored) {
          const displaced = path.join(backupDir, "rollback", item.relativePath)
          await ensurePrivateDirectory(path.dirname(displaced), backupDir, getUid)
          await renamePath(target, displaced)
          await chmod(displaced, 0o600)
        }
        await atomicCreate(
          root,
          item.relativePath,
          item.bytes,
          item.mode,
          backupDir,
          linkPath,
          getUid,
        )
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `llm-router uninstall failed and rollback was incomplete; recovery is in ${backupDir}`,
      )
    }
    throw new Error(
      `llm-router uninstall failed; rollback completed; recovery is in ${backupDir}: ${error.message}`,
      { cause: error },
    )
  }
  return backupDir
}

function previewText(plan, token) {
  const lines = [
    `llm-router uninstall preview (${plan.mode} state).`,
    "Shared configuration:",
  ]
  if (plan.shared.length === 0) {
    lines.push("- none")
  } else {
    for (const item of plan.shared) {
      const changes = item.changes.length > 0 ? `: ${item.changes.join(", ")}` : ""
      lines.push(`- ${item.action} ${item.relativePath}${changes}`)
    }
  }
  lines.push("Managed files:")
  if (plan.files.length === 0) {
    lines.push("- none")
  } else {
    for (const item of plan.files) {
      lines.push(
        `- move ${item.relativePath}${item.restore ? " and restore its original version" : ""}`,
      )
    }
  }
  lines.push("Preserved:")
  for (const item of plan.preserved) lines.push(`- ${item}`)
  lines.push(
    "A timestamped recovery directory will be created after confirmation under "
    + ".llm-router-backups/uninstall/.",
  )
  lines.push(`Confirm with /router-uninstall ${token}`)
  return lines.join("\n")
}

export async function createOpenCodeUninstaller({
  configDir,
  chmodMovedPath = chmod,
  getUid = () => (
    typeof process.getuid === "function" ? process.getuid() : null
  ),
  now = () => new Date(),
  linkPath = link,
  renamePath = rename,
  tokenFactory = () => randomBytes(24).toString("base64url"),
  tokenTtlMs = TOKEN_TTL_MS,
} = {}) {
  const root = await inspectRoot(configDir, getUid)
  let pending = null

  return {
    async execute(argumentsText = "") {
      const argument = String(argumentsText).trim()
      if (argument.length === 0) {
        const plan = await createPlan(root, getUid)
        const token = tokenFactory()
        if (
          typeof token !== "string"
          || !/^[A-Za-z0-9_-]{16,128}$/u.test(token)
        ) {
          fail("tokenFactory returned an unsafe token")
        }
        pending = {
          expiresAt: now().getTime() + tokenTtlMs,
          fingerprint: plan.fingerprint,
          token,
        }
        return previewText(plan, token)
      }

      if (!pending || argument !== pending.token) {
        fail("confirmation token is invalid; request a new preview")
      }
      const confirmation = pending
      pending = null
      if (now().getTime() > confirmation.expiresAt) {
        fail("confirmation token expired; request a new preview")
      }
      const plan = await createPlan(root, getUid)
      if (plan.fingerprint !== confirmation.fingerprint) {
        fail("configuration changed after preview; request a new preview")
      }
      const backupDir = await executePlan({
        chmodMovedPath,
        getUid,
        linkPath,
        now,
        plan,
        renamePath,
        root,
      })
      if (!backupDir) {
        return [
          "No automatic changes were applied without calling an LLM because ownership could not be proven.",
          "Review the preserved items manually.",
          `${POLICY_FILE} was preserved.`,
        ].join("\n")
      }
      const result = [
        plan.preserved.length > 1
          ? "Verified llm-router uninstall changes were applied without calling an LLM; preserved items remain for manual review."
          : "llm-router was uninstalled without calling an LLM.",
        `${POLICY_FILE} was preserved.`,
        "Restart OpenCode to unload the router plugin.",
      ]
      if (backupDir) result.splice(1, 0, `Recovery backup: ${backupDir}`)
      return result.join("\n")
    },
  }
}
