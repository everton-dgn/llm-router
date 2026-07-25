import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
  chmodSync,
} from "node:fs"
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { parse, printParseErrorCode } from "jsonc-parser"

export const INSTALL_STATE_SCHEMA_VERSION = 1
export const INSTALL_STATE_FILENAME = "llm-router.install-state.json"
const SCHEMA_VERSION = INSTALL_STATE_SCHEMA_VERSION
const STATE_NAME = INSTALL_STATE_FILENAME
const BASELINE_ROOT = ".llm-router-backups/install"
const SHARED_FILES = Object.freeze({
  opencode: "opencode.jsonc",
  package: "package.json",
})

function fail(message) {
  throw new Error(message)
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function assertOwned(stat, path) {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    fail(`path is not owned by the current user: ${path}`)
  }
}

function assertPrivateMode(stat, path, expectedMode) {
  const actualMode = stat.mode & 0o777
  if (actualMode !== expectedMode) {
    fail(
      `insecure permissions on ${path}: expected ${expectedMode.toString(8)}, got ${actualMode.toString(8)}`,
    )
  }
}

function assertRegularFile(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) fail(`refusing to use symlink: ${path}`)
  if (!stat.isFile()) fail(`expected a regular file: ${path}`)
  assertOwned(stat, path)
  return stat
}

function assertDirectory(path) {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) fail(`refusing to use symlink directory: ${path}`)
  if (!stat.isDirectory()) fail(`expected a directory: ${path}`)
  assertOwned(stat, path)
  return stat
}

function ensurePrivateDirectory(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  assertDirectory(path)
  chmodSync(path, 0o700)
}

function normalizeConfigDir(configDir) {
  if (!isAbsolute(configDir)) fail(`config directory must be absolute: ${configDir}`)
  let existing = resolve(configDir)
  const suffix = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) fail(`cannot resolve config directory: ${configDir}`)
    suffix.unshift(basename(existing))
    existing = parent
  }
  const canonicalBase = realpathSync(existing)
  return resolve(canonicalBase, ...suffix)
}

function normalizeRelativePath(relativePath) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.includes("\0")
  ) {
    fail(`invalid relative path: ${String(relativePath)}`)
  }
  const normalized = relativePath.replaceAll("\\", "/")
  if (
    normalized === "."
    || normalized.startsWith("../")
    || normalized.includes("/../")
    || normalized.endsWith("/..")
  ) {
    fail(`path escapes the config directory: ${relativePath}`)
  }
  return normalized
}

function resolveInside(configDir, relativePath) {
  const normalized = normalizeRelativePath(relativePath)
  const target = resolve(configDir, normalized)
  const offset = relative(configDir, target)
  if (offset.startsWith(`..${sep}`) || offset === ".." || isAbsolute(offset)) {
    fail(`path escapes the config directory: ${relativePath}`)
  }
  return target
}

function assertNoInternalSymlink(configDir, target) {
  let current = dirname(target)
  while (current !== configDir) {
    if (existsSync(current)) assertDirectory(current)
    const parent = dirname(current)
    if (parent === current) fail(`path escapes the config directory: ${target}`)
    current = parent
  }
}

function ensurePrivateParent(configDir, target) {
  assertNoInternalSymlink(configDir, target)
  const parent = dirname(target)
  ensurePrivateDirectory(parent)
  assertNoInternalSymlink(configDir, target)
}

function copyBaselineFile(configDir, source, backupRelativePath) {
  assertRegularFile(source)
  const destination = resolveInside(configDir, backupRelativePath)
  ensurePrivateParent(configDir, destination)
  copyFileSync(source, destination, constants.COPYFILE_EXCL)
  chmodSync(destination, 0o600)
  return {
    sha256: sha256File(source),
    backupPath: normalizeRelativePath(backupRelativePath),
  }
}

function readJsonc(path, label) {
  assertRegularFile(path)
  const errors = []
  const value = parse(readFileSync(path, "utf8"), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  })
  if (errors.length > 0 || value === undefined) {
    const reason = errors
      .map(({ error, offset }) => `${printParseErrorCode(error)} at offset ${offset}`)
      .join(", ")
    fail(`invalid ${label}: ${path}${reason ? ` (${reason})` : ""}`)
  }
  return value
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function readAtPath(value, path) {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== "object" || !hasOwn(current, key)) {
      return { existed: false }
    }
    current = current[key]
  }
  return { existed: true, value: structuredClone(current) }
}

function managedConfigPaths(requiredConfig) {
  const paths = [
    ["$schema"],
    ["autoupdate"],
    ["model"],
    ["default_agent"],
    ["disabled_providers"],
  ]
  for (const section of ["provider", "command", "agent"]) {
    const entries = requiredConfig[section] ?? {}
    for (const key of Object.keys(entries).sort()) paths.push([section, key])
  }
  return paths.filter((path) => readAtPath(requiredConfig, path).existed)
}

function originalValue(current, path, installedValue, legacy) {
  const original = readAtPath(current, path)
  if (legacy && original.existed && isDeepStrictEqual(original.value, installedValue)) {
    return { known: false, existed: false }
  }
  if (!original.existed) return { known: true, existed: false }
  return { known: true, existed: true, value: original.value }
}

function installedConfigRecords(requiredConfig, currentConfig, legacy) {
  return managedConfigPaths(requiredConfig).map((path) => {
    const installedValue = readAtPath(requiredConfig, path).value
    return {
      path,
      installedValue,
      original: originalValue(currentConfig, path, installedValue, legacy),
    }
  })
}

function installedDependencyRecords(requiredPackage, currentPackage, legacy) {
  const required = requiredPackage.dependencies ?? {}
  const current = currentPackage.dependencies ?? {}
  return Object.keys(required).sort().map((name) => {
    const installedValue = required[name]
    const existed = hasOwn(current, name)
    const isUnknownLegacy = legacy && existed && current[name] === installedValue
    const original = isUnknownLegacy
      ? { known: false, existed: false }
      : existed
        ? { known: true, existed: true, value: current[name] }
        : { known: true, existed: false }
    return { name, installedValue, original }
  })
}

function createBaselineId() {
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/gu, "")
  return `${timestamp}-${process.pid}-${randomBytes(4).toString("hex")}`
}

function createSharedBaseline(configDir, baselineDir, relativePath) {
  const target = resolveInside(configDir, relativePath)
  if (!existsSync(target)) {
    return {
      relativePath,
      existed: false,
      originalSha256: null,
      backupPath: null,
    }
  }
  const backupPath = `shared/${relativePath}`
  const copied = copyBaselineFile(
    configDir,
    target,
    `${baselineDir}/${backupPath}`,
  )
  return {
    relativePath,
    existed: true,
    originalSha256: copied.sha256,
    backupPath,
  }
}

function normalizeManagedFiles(managedFiles) {
  if (!Array.isArray(managedFiles) || managedFiles.length === 0) {
    fail("at least one managed file is required")
  }
  const seen = new Set()
  return managedFiles.map(({ relativePath, sourcePath }) => {
    const normalized = normalizeRelativePath(relativePath)
    if (seen.has(normalized)) fail(`duplicate managed file: ${normalized}`)
    seen.add(normalized)
    if (!isAbsolute(sourcePath)) fail(`managed source must be absolute: ${sourcePath}`)
    assertRegularFile(sourcePath)
    return { relativePath: normalized, sourcePath: resolve(sourcePath) }
  })
}

function detectLegacy(configDir, currentConfig, managedFiles) {
  if (readAtPath(currentConfig, ["agent", "router"]).existed) return true
  if (readAtPath(currentConfig, ["provider", "router-control"]).existed) return true
  const handoff = managedFiles.find(
    ({ relativePath }) => relativePath === "plugins/llm_router_handoff.ts",
  )
  return handoff ? existsSync(resolveInside(configDir, handoff.relativePath)) : false
}

function createManagedFileRecord(configDir, baselineDir, descriptor, legacy) {
  const target = resolveInside(configDir, descriptor.relativePath)
  const installedSha256 = sha256File(descriptor.sourcePath)
  if (!existsSync(target)) {
    return {
      relativePath: descriptor.relativePath,
      ownership: "created",
      installedSha256,
      original: {
        known: true,
        existed: false,
        sha256: null,
        backupPath: null,
      },
    }
  }

  assertNoInternalSymlink(configDir, target)
  const currentSha256 = sha256File(target)
  const unknownLegacy = legacy && currentSha256 === installedSha256
  if (unknownLegacy) {
    return {
      relativePath: descriptor.relativePath,
      ownership: "legacy",
      installedSha256,
      original: {
        known: false,
        existed: false,
        sha256: null,
        backupPath: null,
      },
    }
  }
  const backupPath = `managed/${descriptor.relativePath}`
  const copied = copyBaselineFile(
    configDir,
    target,
    `${baselineDir}/${backupPath}`,
  )
  return {
    relativePath: descriptor.relativePath,
    ownership: "replaced",
    installedSha256,
    original: {
      known: true,
      existed: true,
      sha256: copied.sha256,
      backupPath,
    },
  }
}

function validateStateShape(state, configDir) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    fail("install state must be a JSON object")
  }
  if (state.schemaVersion !== SCHEMA_VERSION) {
    fail(`unsupported install state schema: ${String(state.schemaVersion)}`)
  }
  if (state.configDir !== configDir) {
    fail(`install state belongs to a different config directory: ${state.configDir}`)
  }
  if (!["prepared", "installed"].includes(state.status)) {
    fail(`invalid install state status: ${String(state.status)}`)
  }
  if (typeof state.legacy !== "boolean") fail("install state legacy flag is invalid")
  const baselineDir = normalizeRelativePath(state.baselineDir)
  if (!baselineDir.startsWith(`${BASELINE_ROOT}/`)) {
    fail(`install state baseline is outside ${BASELINE_ROOT}: ${baselineDir}`)
  }
  const baselinePath = resolveInside(configDir, baselineDir)
  assertNoInternalSymlink(configDir, baselinePath)
  const baselineStat = assertDirectory(baselinePath)
  assertPrivateMode(baselineStat, baselinePath, 0o700)
  for (const key of Object.keys(SHARED_FILES)) {
    const baseline = state.sharedBaselines?.[key]
    if (!baseline) fail(`missing shared baseline: ${key}`)
    if (baseline.relativePath !== SHARED_FILES[key]) {
      fail(`invalid shared baseline path: ${String(baseline.relativePath)}`)
    }
    if (typeof baseline.existed !== "boolean") {
      fail(`invalid shared baseline existence flag: ${key}`)
    }
    if (baseline.existed) {
      const backupRelativePath = normalizeRelativePath(baseline.backupPath)
      if (!backupRelativePath.startsWith("shared/")) {
        fail(`shared baseline escapes its directory: ${backupRelativePath}`)
      }
      const backupPath = resolveInside(
        configDir,
        `${baselineDir}/${backupRelativePath}`,
      )
      assertNoInternalSymlink(configDir, backupPath)
      const backupStat = assertRegularFile(backupPath)
      assertPrivateMode(backupStat, backupPath, 0o600)
      if (
        typeof baseline.originalSha256 !== "string"
        || sha256File(backupPath) !== baseline.originalSha256
      ) {
        fail(`shared baseline hash mismatch: ${key}`)
      }
    } else if (baseline.backupPath !== null || baseline.originalSha256 !== null) {
      fail(`absent shared baseline has backup data: ${key}`)
    }
  }
  if (!Array.isArray(state.managedConfig)) fail("managedConfig must be an array")
  if (!Array.isArray(state.managedDependencies)) {
    fail("managedDependencies must be an array")
  }
  if (!Array.isArray(state.managedFiles)) fail("managedFiles must be an array")
  const managedPaths = new Set()
  for (const record of state.managedConfig) {
    if (
      !Array.isArray(record.path)
      || record.path.length === 0
      || record.path.some((part) =>
        typeof part !== "string"
        || part.length === 0
        || ["__proto__", "constructor", "prototype"].includes(part)
      )
    ) {
      fail("managedConfig contains an invalid path")
    }
    if (!record.original || typeof record.original.known !== "boolean") {
      fail(`managedConfig original metadata is invalid: ${JSON.stringify(record.path)}`)
    }
    if (typeof record.original.existed !== "boolean") {
      fail(`managedConfig original existence is invalid: ${JSON.stringify(record.path)}`)
    }
    if (!record.original.known && record.original.existed) {
      fail(`managedConfig unknown original cannot be marked as existing: ${JSON.stringify(record.path)}`)
    }
  }
  for (const record of state.managedDependencies) {
    if (typeof record.name !== "string" || record.name.length === 0) {
      fail("managedDependencies contains an invalid name")
    }
    if (!record.original || typeof record.original.known !== "boolean") {
      fail(`managed dependency original metadata is invalid: ${record.name}`)
    }
    if (typeof record.original.existed !== "boolean") {
      fail(`managed dependency original existence is invalid: ${record.name}`)
    }
    if (!record.original.known && record.original.existed) {
      fail(`managed dependency unknown original cannot be marked as existing: ${record.name}`)
    }
  }
  for (const record of state.managedFiles) {
    const relativePath = normalizeRelativePath(record.relativePath)
    if (managedPaths.has(relativePath)) fail(`duplicate managed file: ${relativePath}`)
    managedPaths.add(relativePath)
    if (!["created", "replaced", "legacy"].includes(record.ownership)) {
      fail(`invalid managed file ownership: ${String(record.ownership)}`)
    }
    if (
      typeof record.installedSha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(record.installedSha256)
    ) {
      fail(`invalid installed hash: ${relativePath}`)
    }
    if (!record.original || typeof record.original.known !== "boolean") {
      fail(`managed file original metadata is invalid: ${relativePath}`)
    }
    if (typeof record.original.existed !== "boolean") {
      fail(`managed file original existence is invalid: ${relativePath}`)
    }
    if (record.original.existed) {
      const backupRelativePath = normalizeRelativePath(record.original.backupPath)
      if (!backupRelativePath.startsWith("managed/")) {
        fail(`managed baseline escapes its directory: ${backupRelativePath}`)
      }
      const backupPath = resolveInside(
        configDir,
        `${baselineDir}/${backupRelativePath}`,
      )
      assertNoInternalSymlink(configDir, backupPath)
      const backupStat = assertRegularFile(backupPath)
      assertPrivateMode(backupStat, backupPath, 0o600)
      if (
        typeof record.original.sha256 !== "string"
        || sha256File(backupPath) !== record.original.sha256
      ) {
        fail(`managed baseline hash mismatch: ${relativePath}`)
      }
    } else if (!record.original.known && record.ownership !== "legacy") {
      fail(`unknown managed original requires legacy ownership: ${relativePath}`)
    } else if (
      record.original.backupPath !== null
      || record.original.sha256 !== null
    ) {
      fail(`absent managed original has backup data: ${relativePath}`)
    }
  }
  return state
}

export function readInstallState(configDirValue) {
  const configDir = normalizeConfigDir(configDirValue)
  const statePath = resolveInside(configDir, STATE_NAME)
  if (!existsSync(statePath)) return null
  const stateStat = assertRegularFile(statePath)
  assertPrivateMode(stateStat, statePath, 0o600)
  const state = readJsonc(statePath, "install state")
  return validateStateShape(state, configDir)
}

function preservePreviousState(configDir, state) {
  const statePath = resolveInside(configDir, STATE_NAME)
  if (!existsSync(statePath)) return
  assertRegularFile(statePath)
  const historyName = `${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${process.pid}-${randomBytes(4).toString("hex")}.json`
  const historyRelative = `${state.baselineDir}/state-history/${historyName}`
  copyBaselineFile(configDir, statePath, historyRelative)
}

function comparableState(state) {
  const copy = structuredClone(state)
  delete copy.updatedAt
  return copy
}

function writeAtomicState(configDir, previousState, nextState) {
  if (
    previousState
    && isDeepStrictEqual(comparableState(previousState), comparableState(nextState))
  ) {
    return previousState
  }

  if (previousState) preservePreviousState(configDir, previousState)
  const statePath = resolveInside(configDir, STATE_NAME)
  const pendingPath = resolveInside(
    configDir,
    `.${STATE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.pending`,
  )
  const descriptor = openSync(
    pendingPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  )
  try {
    writeFileSync(descriptor, `${JSON.stringify(nextState, null, 2)}\n`, "utf8")
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  chmodSync(pendingPath, 0o600)
  renameSync(pendingPath, statePath)
  chmodSync(statePath, 0o600)
  return nextState
}

function mergeRecords(existing, incoming, keyOf, { retainMissing = true } = {}) {
  const incomingByKey = new Map(incoming.map((record) => [keyOf(record), record]))
  const merged = existing.flatMap((record) => {
    const update = incomingByKey.get(keyOf(record))
    if (!update) return retainMissing ? [record] : []
    incomingByKey.delete(keyOf(record))
    const mergedRecord = { ...record }
    if (hasOwn(update, "installedValue")) {
      mergedRecord.installedValue = update.installedValue
    }
    if (hasOwn(update, "installedSha256")) {
      mergedRecord.installedSha256 = update.installedSha256
    }
    return [mergedRecord]
  })
  merged.push(...incomingByKey.values())
  return merged
}

function installInputs(options) {
  const configDir = normalizeConfigDir(options.configDir)
  const requiredConfigPath = resolve(options.requiredConfigPath)
  const requiredPackagePath = resolve(options.requiredPackagePath)
  const managedFiles = normalizeManagedFiles(options.managedFiles)
  const requiredConfig = readJsonc(requiredConfigPath, "required OpenCode config")
  const requiredPackage = readJsonc(requiredPackagePath, "required package")
  return {
    configDir,
    requiredConfig,
    requiredPackage,
    managedFiles,
  }
}

export function prepareInstallState(options) {
  const inputs = installInputs(options)
  ensurePrivateDirectory(inputs.configDir)
  for (const descriptor of inputs.managedFiles) {
    const target = resolveInside(inputs.configDir, descriptor.relativePath)
    assertNoInternalSymlink(inputs.configDir, target)
    if (existsSync(target)) assertRegularFile(target)
  }
  const existingState = readInstallState(inputs.configDir)
  const backupRoot = resolveInside(inputs.configDir, ".llm-router-backups")
  const installRoot = resolveInside(inputs.configDir, BASELINE_ROOT)
  ensurePrivateDirectory(backupRoot)
  ensurePrivateDirectory(installRoot)

  if (!existingState) {
    const baselineDir = `${BASELINE_ROOT}/${createBaselineId()}`
    ensurePrivateDirectory(resolveInside(inputs.configDir, baselineDir))
    const currentConfig = existsSync(resolveInside(inputs.configDir, SHARED_FILES.opencode))
      ? readJsonc(
        resolveInside(inputs.configDir, SHARED_FILES.opencode),
        "current OpenCode config",
      )
      : {}
    const currentPackage = existsSync(resolveInside(inputs.configDir, SHARED_FILES.package))
      ? readJsonc(resolveInside(inputs.configDir, SHARED_FILES.package), "current package")
      : {}
    const legacy = detectLegacy(inputs.configDir, currentConfig, inputs.managedFiles)
    const now = new Date().toISOString()
    const state = {
      schemaVersion: SCHEMA_VERSION,
      status: "prepared",
      legacy,
      configDir: inputs.configDir,
      baselineDir,
      createdAt: now,
      updatedAt: now,
      sharedBaselines: {
        opencode: createSharedBaseline(
          inputs.configDir,
          baselineDir,
          SHARED_FILES.opencode,
        ),
        package: createSharedBaseline(
          inputs.configDir,
          baselineDir,
          SHARED_FILES.package,
        ),
      },
      managedConfig: installedConfigRecords(
        inputs.requiredConfig,
        currentConfig,
        legacy,
      ),
      managedDependencies: installedDependencyRecords(
        inputs.requiredPackage,
        currentPackage,
        legacy,
      ),
      managedFiles: inputs.managedFiles.map((descriptor) =>
        createManagedFileRecord(inputs.configDir, baselineDir, descriptor, legacy)
      ),
    }
    return writeAtomicState(inputs.configDir, null, state)
  }

  const currentConfig = existsSync(resolveInside(inputs.configDir, SHARED_FILES.opencode))
    ? readJsonc(
      resolveInside(inputs.configDir, SHARED_FILES.opencode),
      "current OpenCode config",
    )
    : {}
  const currentPackage = existsSync(resolveInside(inputs.configDir, SHARED_FILES.package))
    ? readJsonc(resolveInside(inputs.configDir, SHARED_FILES.package), "current package")
    : {}
  const knownFiles = new Set(
    existingState.managedFiles.map(({ relativePath }) => relativePath),
  )
  const newFiles = inputs.managedFiles
    .filter(({ relativePath }) => !knownFiles.has(relativePath))
    .map((descriptor) =>
      createManagedFileRecord(
        inputs.configDir,
        existingState.baselineDir,
        descriptor,
        false,
      )
    )
  const incomingFiles = inputs.managedFiles.map((descriptor) => ({
    relativePath: descriptor.relativePath,
    installedSha256: sha256File(descriptor.sourcePath),
  }))
  const nextState = {
    ...existingState,
    status: "prepared",
    updatedAt: new Date().toISOString(),
    managedConfig: mergeRecords(
      existingState.managedConfig,
      installedConfigRecords(inputs.requiredConfig, currentConfig, false),
      (record) => JSON.stringify(record.path),
      { retainMissing: false },
    ),
    managedDependencies: mergeRecords(
      existingState.managedDependencies,
      installedDependencyRecords(inputs.requiredPackage, currentPackage, false),
      (record) => record.name,
    ),
    managedFiles: mergeRecords(
      [...existingState.managedFiles, ...newFiles],
      incomingFiles,
      (record) => record.relativePath,
    ),
  }

  const expectedChanged = !isDeepStrictEqual(
    comparableState({ ...existingState, status: "prepared" }),
    comparableState(nextState),
  )
  if (!expectedChanged) return existingState
  return writeAtomicState(inputs.configDir, existingState, nextState)
}

export function finalizeInstallState(options) {
  const inputs = installInputs(options)
  const existingState = readInstallState(inputs.configDir)
  if (!existingState) fail("cannot finalize installation without prepared state")

  const sourceByPath = new Map(
    inputs.managedFiles.map((descriptor) => [descriptor.relativePath, descriptor]),
  )
  const finalizedFiles = existingState.managedFiles.map((record) => {
    const descriptor = sourceByPath.get(record.relativePath)
    if (!descriptor) return record
    const target = resolveInside(inputs.configDir, descriptor.relativePath)
    assertNoInternalSymlink(inputs.configDir, target)
    assertRegularFile(target)
    const installedSha256 = sha256File(target)
    const sourceSha256 = sha256File(descriptor.sourcePath)
    if (installedSha256 !== sourceSha256) {
      fail(`installed file does not match rendered source: ${record.relativePath}`)
    }
    return { ...record, installedSha256 }
  })
  const currentConfig = readJsonc(
    resolveInside(inputs.configDir, SHARED_FILES.opencode),
    "installed OpenCode config",
  )
  const currentPackage = readJsonc(
    resolveInside(inputs.configDir, SHARED_FILES.package),
    "installed package",
  )
  const now = new Date().toISOString()
  const nextState = {
    ...existingState,
    status: "installed",
    updatedAt: now,
    managedConfig: mergeRecords(
      existingState.managedConfig,
      installedConfigRecords(inputs.requiredConfig, currentConfig, false),
      (record) => JSON.stringify(record.path),
    ),
    managedDependencies: mergeRecords(
      existingState.managedDependencies,
      installedDependencyRecords(inputs.requiredPackage, currentPackage, false),
      (record) => record.name,
    ),
    managedFiles: finalizedFiles,
  }
  return writeAtomicState(inputs.configDir, existingState, nextState)
}

function parseCli(argv) {
  const [command, ...args] = argv
  if (!["prepare", "finalize"].includes(command)) {
    fail("usage: install_state.mjs prepare|finalize [options]")
  }
  const options = { managedFiles: [] }
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]
    if (option === "--managed-file") {
      const relativePath = args[index + 1]
      const sourcePath = args[index + 2]
      if (!relativePath || !sourcePath) fail("--managed-file requires RELATIVE SOURCE")
      options.managedFiles.push({ relativePath, sourcePath })
      index += 2
      continue
    }
    const value = args[index + 1]
    if (!value) fail(`${option} requires a value`)
    if (option === "--config-dir") options.configDir = value
    else if (option === "--required-config") options.requiredConfigPath = value
    else if (option === "--required-package") options.requiredPackagePath = value
    else fail(`unknown option: ${option}`)
    index += 1
  }
  if (!options.configDir) fail("--config-dir is required")
  if (!options.requiredConfigPath) fail("--required-config is required")
  if (!options.requiredPackagePath) fail("--required-package is required")
  return { command, options }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    const { command, options } = parseCli(process.argv.slice(2))
    const state = command === "prepare"
      ? prepareInstallState(options)
      : finalizeInstallState(options)
    process.stdout.write(`${state.status} ${resolveInside(state.configDir, STATE_NAME)}\n`)
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
