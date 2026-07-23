import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertRemoteCiSuccess
} from './release-preflight.mjs'
import {
  assertReleaseChangedFiles,
  assertReleasePayload
} from './release-payload.mjs'
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

  const tagLineage = requireGitOutput(
    runGit,
    ['rev-list', '--parents', '-n', '1', tagCommit],
    'the release tag commit lineage'
  ).split(/\s+/u)
  if (tagLineage[0] !== tagCommit || ![2, 3].includes(tagLineage.length)) {
    throw new Error(
      `Release tag ${normalizedTag} must point to a release commit or normal merge commit`
    )
  }
  const isMergeRelease = tagLineage.length === 3
  const base = tagLineage[1]
  const releaseHead = isMergeRelease ? tagLineage[2] : tagCommit
  const releaseLineage = isMergeRelease
    ? requireGitOutput(
        runGit,
        ['rev-list', '--parents', '-n', '1', releaseHead],
        'the release branch commit lineage'
      ).split(/\s+/u)
    : tagLineage
  if (releaseLineage.length !== 2 || releaseLineage[0] !== releaseHead) {
    throw new Error('Release branch must contain exactly one release commit')
  }
  const source = releaseLineage[1]
  if (isMergeRelease) {
    const sourceBase = requireGitOutput(
      runGit,
      ['merge-base', source, base],
      'the merge base of the release source and release base'
    )
    if (sourceBase !== source) {
      throw new Error('Release source must be an ancestor of the merge base')
    }
  }

  const subject = requireGitOutput(
    runGit,
    ['log', '-1', '--format=%s', releaseHead],
    'the release commit subject'
  )
  if (subject !== `chore(release): cut ${normalizedTag}`) {
    throw new Error(`Unexpected release commit subject: ${subject}`)
  }
  const releaseFiles = runGit([
    'diff',
    '--name-only',
    source,
    releaseHead
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  assertReleaseChangedFiles(releaseFiles)
  if (isMergeRelease) {
    const mergeFiles = runGit([
      'diff',
      '--name-only',
      base,
      tagCommit
    ])
      .split(/\r?\n/u)
      .map(file => file.trim())
      .filter(Boolean)
    assertReleaseChangedFiles(mergeFiles)
  }

  const releaseManifestText = requireGitOutput(
    runGit,
    ['show', `${releaseHead}:package.json`],
    'the release branch package.json'
  )
  const sourceManifestText = requireGitOutput(
    runGit,
    ['show', `${source}:package.json`],
    'the release source package.json'
  )
  const releaseChangelog = requireGitOutput(
    runGit,
    ['show', `${releaseHead}:CHANGELOG.md`],
    'the release branch changelog'
  )
  const releaseVersion = assertReleasePayload({
    changelog: releaseChangelog,
    currentManifest: JSON.parse(releaseManifestText),
    previousManifest: JSON.parse(sourceManifestText)
  })
  if (`v${releaseVersion}` !== normalizedTag) {
    throw new Error(
      `Release tag ${normalizedTag} does not match package.json version ${releaseVersion}`
    )
  }

  if (isMergeRelease) {
    const mergeManifestText = requireGitOutput(
      runGit,
      ['show', `${tagCommit}:package.json`],
      'the merged release package.json'
    )
    const baseManifestText = requireGitOutput(
      runGit,
      ['show', `${base}:package.json`],
      'the release base package.json'
    )
    const mergeChangelog = requireGitOutput(
      runGit,
      ['show', `${tagCommit}:CHANGELOG.md`],
      'the merged release changelog'
    )
    if (
      mergeManifestText !== releaseManifestText ||
      mergeChangelog !== releaseChangelog
    ) {
      throw new Error(
        'Merged release payload must match the validated release branch'
      )
    }
    assertReleasePayload({
      changelog: mergeChangelog,
      currentManifest: JSON.parse(mergeManifestText),
      previousManifest: JSON.parse(baseManifestText)
    })
  }

  const ci = assertCi({ head: base, runGit })
  return {
    parent: base,
    releaseHead,
    repository: ci.repository,
    runId: ci.runId,
    source,
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
        `Verified ${result.tag} at ${result.tagCommit} with base CI run ${result.runId}.`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
