import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectIgnoredCommits,
  deriveBumpFromCommits
} from './derive-bump-from-commits.mjs'
import {
  computeNextReleaseVersion,
  resolveAutoBump
} from './release-version-utils.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(rootDir, 'package.json')

function readCurrentVersion() {
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
  return String(manifest.version ?? '').trim()
}

function parseArgs(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--mode' ||
    argv[1] !== 'auto' ||
    argv[2] !== '--print'
  ) {
    throw new Error(
      'Usage: node scripts/set-release-version.mjs --mode auto --print'
    )
  }
}

export function tryLatestStableTag() {
  const tags = execFileSync(
    'git',
    ['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname'],
    { cwd: rootDir, encoding: 'utf8' }
  )
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(tag => /^v\d+\.\d+\.\d+$/.test(tag))
  return tags[0] ?? ''
}

export function collectCommitMessages({
  baselineTag,
  runGit = args =>
    execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' })
}) {
  const range = baselineTag ? `${baselineTag}..HEAD` : 'HEAD'
  const output = runGit([
    'log',
    range,
    '--no-merges',
    '--format=%B%x00'
  ])
  return String(output)
    .split('\u0000')
    .map(message => message.trim())
    .filter(Boolean)
}

export function deriveAutomaticVersion({
  currentVersion,
  baselineTag,
  messages
}) {
  if (baselineTag) {
    const taggedVersion = baselineTag.replace(/^v/, '')
    if (taggedVersion !== currentVersion) {
      throw new Error(
        `package.json version ${currentVersion} does not match latest tag ${baselineTag}`
      )
    }
  } else if (currentVersion !== '0.0.0') {
    throw new Error(
      'The first release must start from package.json version 0.0.0'
    )
  }

  const derivedBump = deriveBumpFromCommits(messages)
  if (derivedBump === null) {
    return { bump: null, version: null }
  }
  const bump = baselineTag
    ? resolveAutoBump(derivedBump, currentVersion)
    : 'major'
  return {
    bump,
    version: computeNextReleaseVersion(currentVersion, bump)
  }
}

function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: rootDir,
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

function remoteTagExists(tag) {
  try {
    const output = execFileSync(
      'git',
      ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`],
      { cwd: rootDir, encoding: 'utf8' }
    )
    return output.trim().length > 0
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 2) {
      return false
    }
    throw error
  }
}

export function runReleaseVersionPreview(
  argv = process.argv.slice(2),
  {
    getCurrentVersion = readCurrentVersion,
    getBaselineTag = tryLatestStableTag,
    getMessages = collectCommitMessages,
    hasLocalTag = tagExists,
    hasRemoteTag = remoteTagExists
  } = {}
) {
  parseArgs(argv)
  const currentVersion = getCurrentVersion()
  const baselineTag = getBaselineTag()
  const messages = getMessages({ baselineTag })
  const ignored = collectIgnoredCommits(messages)
  if (ignored.length > 0) {
    process.stderr.write(
      `Warning: ignored non-conventional commits since ${baselineTag || 'repository start'}:\n${ignored.map(subject => `- ${subject}`).join('\n')}\n`
    )
  }
  const derived = deriveAutomaticVersion({
    currentVersion,
    baselineTag,
    messages
  })
  if (derived.version === null) {
    process.stdout.write('none\n')
    return null
  }
  const nextVersion = derived.version

  const tag = `v${nextVersion}`
  if (hasLocalTag(tag)) {
    throw new Error(`Release tag ${tag} already exists locally`)
  }
  if (hasRemoteTag(tag)) {
    throw new Error(`Release tag ${tag} already exists on origin`)
  }
  process.stdout.write(`${nextVersion}\n`)
  return nextVersion
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  runReleaseVersionPreview()
}
