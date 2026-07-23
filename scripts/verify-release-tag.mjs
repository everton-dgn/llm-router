import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertRemoteCiSuccess
} from './release-preflight.mjs'
import {
  assertReleasePayload
} from './push-current-release-tag.mjs'
import {
  normalizeReleaseTag
} from './release-version-utils.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const runGitCommand = args =>
  execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim()

function requireGitOutput(runGit, args, label) {
  const output = runGit(args)
  if (typeof output !== 'string' || output.trim().length === 0) {
    throw new Error(`Cannot resolve ${label}`)
  }
  return output.trim()
}

export function verifyPublishedReleaseTag({
  assertCi = assertRemoteCiSuccess,
  runGit = runGitCommand,
  tag
}) {
  const normalizedTag = normalizeReleaseTag(tag)
  const tagType = requireGitOutput(
    runGit,
    ['cat-file', '-t', `refs/tags/${normalizedTag}`],
    `${normalizedTag} object type`
  )
  if (tagType !== 'tag') {
    throw new Error(`Release tag ${normalizedTag} must be annotated`)
  }

  const tagCommit = requireGitOutput(
    runGit,
    ['rev-list', '-n', '1', `refs/tags/${normalizedTag}`],
    `${normalizedTag} commit`
  )
  const advertisedMain = requireGitOutput(
    runGit,
    ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main'],
    'the main branch advertised by origin'
  ).split(/\s+/u)[0]
  const mergeBase = requireGitOutput(
    runGit,
    ['merge-base', tagCommit, advertisedMain],
    `the merge base of ${normalizedTag} and remote main`
  )
  if (mergeBase !== tagCommit) {
    throw new Error(
      `Release tag ${normalizedTag} must be reachable from remote main`
    )
  }

  const subject = requireGitOutput(
    runGit,
    ['log', '-1', '--format=%s', tagCommit],
    'the release commit subject'
  )
  if (subject !== `chore(release): cut ${normalizedTag}`) {
    throw new Error(`Unexpected release commit subject: ${subject}`)
  }
  const changedFiles = runGit([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    tagCommit
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  if (changedFiles.length !== 1 || changedFiles[0] !== 'package.json') {
    throw new Error(
      `Release commit must change only package.json, received: ${changedFiles.join(', ') || 'no files'}`
    )
  }

  const parent = requireGitOutput(
    runGit,
    ['rev-parse', '--verify', `${tagCommit}^1^{commit}`],
    'the release commit parent'
  )
  const currentManifest = JSON.parse(
    requireGitOutput(
      runGit,
      ['show', `${tagCommit}:package.json`],
      'the release package.json'
    )
  )
  const previousManifest = JSON.parse(
    requireGitOutput(
      runGit,
      ['show', `${parent}:package.json`],
      'the source package.json'
    )
  )
  const changelog = requireGitOutput(
    runGit,
    ['show', `${tagCommit}:CHANGELOG.md`],
    'the release changelog'
  )
  const version = assertReleasePayload({
    changelog,
    currentManifest,
    previousManifest
  })
  if (`v${version}` !== normalizedTag) {
    throw new Error(
      `Release tag ${normalizedTag} does not match package.json version ${version}`
    )
  }

  const ci = assertCi({ head: parent, runGit })
  return {
    parent,
    repository: ci.repository,
    runId: ci.runId,
    tag: normalizedTag,
    tagCommit
  }
}

function parseArgs(argv) {
  const printCommit = argv.includes('--print-commit')
  const filtered = argv.filter(argument => argument !== '--print-commit')
  if (filtered.length !== 2 || filtered[0] !== '--tag' || !filtered[1]) {
    throw new Error(
      'Usage: node scripts/verify-release-tag.mjs --tag vX.Y.Z [--print-commit]'
    )
  }
  return { printCommit, tag: filtered[1] }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = verifyPublishedReleaseTag(args)
    if (args.printCommit) {
      console.log(result.tagCommit)
    } else {
      console.log(
        `Verified ${result.tag} at ${result.tagCommit} with source CI run ${result.runId}.`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
