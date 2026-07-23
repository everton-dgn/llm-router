import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'

import {
  assertRemoteCiSuccess,
  assertReleasePushReady
} from './release-preflight.mjs'
import {
  computeNextReleaseVersion,
  parseReleaseVersion
} from './release-version-utils.mjs'
import { parseChangelog } from './sync-release-notes-from-changelog.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(rootDir, 'package.json')
const changelogPath = path.join(rootDir, 'CHANGELOG.md')

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: options.encoding,
    stdio: options.encoding ? undefined : 'inherit'
  })?.trim()
}

export function getRemoteTagState(tag, readGit = args =>
  runGit(args, { encoding: 'utf8' })) {
  let objectId = ''
  try {
    objectId = readGit([
      'ls-remote',
      '--exit-code',
      '--refs',
      'origin',
      `refs/tags/${tag}`
    ])
      .split(/\s+/)[0]
      .trim()
  } catch {
    return { commit: '', objectId: '' }
  }

  try {
    const commit = readGit([
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/tags/${tag}^{}`
    ])
      .split(/\s+/)[0]
      .trim()
    return { commit, objectId }
  } catch {
    return { commit: objectId, objectId }
  }
}

export function createReleasePushArguments(
  tag,
  remoteMainObjectId,
  remoteTagObjectId = ''
) {
  if (!/^[0-9a-f]{40,64}$/i.test(remoteMainObjectId)) {
    throw new Error('Release push requires the observed remote main object')
  }
  return [
    'push',
    '--atomic',
    `--force-with-lease=refs/heads/main:${remoteMainObjectId}`,
    `--force-with-lease=refs/tags/${tag}:${remoteTagObjectId}`,
    'origin',
    'HEAD:main',
    remoteTagObjectId
      ? `${remoteTagObjectId}:refs/tags/${tag}`
      : `refs/tags/${tag}`
  ]
}

function hasLocalObject(objectId, readGit) {
  try {
    readGit(['cat-file', '-e', `${objectId}^{object}`])
    return true
  } catch {
    return false
  }
}

export function assertReleasePayload({
  changelog,
  currentManifest,
  previousManifest
}) {
  const currentVersion = parseReleaseVersion(currentManifest.version).version
  const previousVersion = parseReleaseVersion(previousManifest.version).version
  const { version: _currentVersion, ...currentRest } = currentManifest
  const { version: _previousVersion, ...previousRest } = previousManifest
  if (!isDeepStrictEqual(currentRest, previousRest)) {
    throw new Error(
      'Release commit may change only the package.json version field'
    )
  }
  const isSingleBump = ['patch', 'minor', 'major'].some(
    mode =>
      computeNextReleaseVersion(previousVersion, mode) === currentVersion
  )
  if (!isSingleBump) {
    throw new Error(
      `Release version ${previousVersion} -> ${currentVersion} is not one supported SemVer bump`
    )
  }
  const changelogVersion = parseChangelog(changelog)[0].version
  if (changelogVersion !== currentVersion) {
    throw new Error(
      `Latest CHANGELOG.md release ${changelogVersion} does not match package.json ${currentVersion}`
    )
  }
  return currentVersion
}

export function pushCurrentReleaseTag({
  assertCi = assertRemoteCiSuccess,
  assertPushReady = assertReleasePushReady,
  getChangelog = () => readFileSync(changelogPath, 'utf8'),
  getCurrentManifest = () =>
    JSON.parse(readFileSync(packagePath, 'utf8')),
  readGit = args => runGit(args, { encoding: 'utf8' }),
  writeGit = args => runGit(args)
} = {}) {
  const manifest = getCurrentManifest()
  const version = String(manifest.version ?? '').trim()
  parseReleaseVersion(version)
  const tag = `v${version}`

  const { advertisedMain, head } = assertPushReady({
    expectedSubject: `chore(release): cut ${tag}`
  })
  const previousManifest = JSON.parse(
    readGit(['show', 'HEAD^:package.json'])
  )
  assertReleasePayload({
    changelog: getChangelog(),
    currentManifest: manifest,
    previousManifest
  })
  const ci = assertCi({ head: advertisedMain })
  console.log(
    `Verified remote CI run ${ci.runId} for ${advertisedMain} in ${ci.repository}.`
  )
  let localTagCommit = ''
  try {
    localTagCommit = readGit(['rev-list', '-n', '1', tag])
  } catch {
    writeGit(['tag', '-a', tag, '-m', tag])
    localTagCommit = readGit(['rev-list', '-n', '1', tag])
  }
  if (localTagCommit !== head) {
    throw new Error(
      `Local tag ${tag} points to ${localTagCommit}, but HEAD is ${head}`
    )
  }

  const remoteTag = getRemoteTagState(tag, readGit)
  if (remoteTag.commit && remoteTag.commit !== localTagCommit) {
    throw new Error(
      `Remote tag ${tag} points to ${remoteTag.commit}, but local tag points to ${localTagCommit}`
    )
  }
  if (
    remoteTag.objectId &&
    !hasLocalObject(remoteTag.objectId, readGit)
  ) {
    writeGit(['fetch', '--no-tags', 'origin', `refs/tags/${tag}`])
    if (!hasLocalObject(remoteTag.objectId, readGit)) {
      throw new Error(`Remote tag ${tag} changed while preparing the push`)
    }
  }

  writeGit(
    createReleasePushArguments(tag, advertisedMain, remoteTag.objectId)
  )
  console.log(`Release push complete: main and ${tag}`)
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  pushCurrentReleaseTag()
}
