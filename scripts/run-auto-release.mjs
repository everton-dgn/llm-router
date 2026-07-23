import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertRemoteCiSuccess } from './release-preflight.mjs'
import {
  computeNextReleaseVersion,
  parseReleaseVersion
} from './release-version-utils.mjs'
import { runSetReleaseVersion } from './set-release-version.mjs'
import { parseChangelog } from './sync-release-notes-from-changelog.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(rootDir, 'package.json')
const changelogPath = path.join(rootDir, 'CHANGELOG.md')
const versionScript = path.join(rootDir, 'scripts/set-release-version.mjs')

const runPnpmCommand = args =>
  execFileSync('pnpm', args, { cwd: rootDir, stdio: 'inherit' })

const readNextVersion = () =>
  parseAutomaticVersionOutput(
    execFileSync(
      process.execPath,
      [versionScript, '--mode', 'auto', '--print'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['inherit', 'pipe', 'inherit']
      }
    )
  )

export function parseAutomaticVersionOutput(output) {
  const version = String(output).trim()
  if (version === 'none') return version
  try {
    return parseReleaseVersion(version).version
  } catch {
    throw new Error(`Unexpected automatic version output: ${version}`)
  }
}

export function readLatestChangelogVersion(source) {
  return parseChangelog(source)[0]?.version ?? null
}

export function resolveReleaseMode(currentVersion, nextVersion) {
  for (const mode of ['patch', 'minor', 'major']) {
    if (computeNextReleaseVersion(currentVersion, mode) === nextVersion) {
      return mode
    }
  }
  throw new Error(
    `Cannot map release version ${currentVersion} -> ${nextVersion} to one SemVer bump`
  )
}

export function runAutoRelease({
  assertCi = assertRemoteCiSuccess,
  getChangelog = () => readFileSync(changelogPath, 'utf8'),
  getCurrentVersion = () =>
    String(JSON.parse(readFileSync(packagePath, 'utf8')).version ?? '').trim(),
  getHeadCommit = () =>
    execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: rootDir,
      encoding: 'utf8'
    }).trim(),
  getNextVersion = readNextVersion,
  runPnpm = runPnpmCommand,
  setVersion = mode => runSetReleaseVersion(['--mode', mode]),
  writeOutput = message => process.stdout.write(message)
} = {}) {
  runPnpm(['release:preflight'])
  const nextVersion = getNextVersion()
  if (nextVersion === 'none') {
    writeOutput('No release-worthy commits since the latest tag.\n')
    return { status: 'skipped' }
  }

  const currentVersion = getCurrentVersion()
  const mode = resolveReleaseMode(currentVersion, nextVersion)
  const changelogVersion = readLatestChangelogVersion(getChangelog())
  if (changelogVersion !== nextVersion) {
    throw new Error(
      `Expected the latest CHANGELOG.md entry to be ${nextVersion}, received ${changelogVersion ?? 'none'}`
    )
  }

  writeOutput(`Preparing ${mode} release v${nextVersion}.\n`)
  runPnpm(['release:check'])
  const sourceHead = getHeadCommit()
  const ci = assertCi({ head: sourceHead })
  writeOutput(
    `Verified remote CI run ${ci.runId} for ${sourceHead} in ${ci.repository}.\n`
  )
  setVersion(mode)
  if (getHeadCommit() === sourceHead) {
    throw new Error('Release versioning did not create a new commit')
  }
  runPnpm(['release:push'])
  return { mode, status: 'released', version: nextVersion }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  runAutoRelease()
}
