import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareReleaseWorkingTree } from './prepare-release-pr.mjs'
import {
  assertRemoteCiSuccess
} from './release-preflight.mjs'
import {
  assertReleaseChangedFiles,
  assertReleasePayload
} from './release-payload.mjs'
import {
  normalizeReleaseTag,
  parseReleaseVersion
} from './release-version-utils.mjs'
import {
  syncReleaseNotes
} from './sync-release-notes-from-changelog.mjs'
import {
  verifyPublishedReleaseTag
} from './verify-release-tag.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shaPattern = /^[0-9a-f]{40,64}$/iu
const repositoryPattern =
  /^(?<owner>[A-Za-z0-9_.-]+)\/(?<repo>[A-Za-z0-9_.-]+)$/u
const botLogins = new Set(['github-actions', 'github-actions[bot]'])
const releaseBaseCiPollAttempts = 30
const releaseBaseCiPollIntervalMs = 10_000

function execute(command, args, {
  encoding,
  env,
  stdio
} = {}) {
  return execFileSync(command, args, {
    cwd: rootDir,
    encoding,
    env: env ? { ...process.env, ...env } : process.env,
    stdio
  })?.trim()
}

function readGit(args) {
  return execute('git', args, { encoding: 'utf8' })
}

function writeGit(args, options = {}) {
  return execute('git', args, {
    env: options.env,
    stdio: 'inherit'
  })
}

function readGhJson(args) {
  return JSON.parse(execute('gh', args, { encoding: 'utf8' }))
}

function writeGhJson(args) {
  return JSON.parse(execute('gh', args, { encoding: 'utf8' }))
}

function isGitAncestor(ancestor, descendant) {
  try {
    execute('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      stdio: 'ignore'
    })
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.status === 1) {
      return false
    }
    throw error
  }
}

export function parseAutomaticReleaseContext(env = process.env) {
  const context = {
    conclusion: String(env.RELEASE_SOURCE_CONCLUSION ?? ''),
    event: String(env.RELEASE_SOURCE_EVENT ?? ''),
    githubActions: String(env.GITHUB_ACTIONS ?? ''),
    headBranch: String(env.RELEASE_SOURCE_BRANCH ?? ''),
    repository: String(env.GITHUB_REPOSITORY ?? ''),
    runId: String(env.RELEASE_SOURCE_RUN_ID ?? ''),
    sourceRepository: String(env.RELEASE_SOURCE_REPOSITORY ?? ''),
    sourceSha: String(env.RELEASE_SOURCE_SHA ?? '')
  }
  const match = context.repository.match(repositoryPattern)
  if (context.githubActions !== 'true') {
    throw new Error('Automatic releases run only inside GitHub Actions')
  }
  if (!match?.groups || context.sourceRepository !== context.repository) {
    throw new Error('Release source must be the current GitHub repository')
  }
  if (
    context.conclusion !== 'success' ||
    context.event !== 'push' ||
    context.headBranch !== 'main'
  ) {
    throw new Error(
      'Automatic releases require a successful CI push run on main'
    )
  }
  if (!shaPattern.test(context.sourceSha)) {
    throw new Error('Automatic release source SHA is invalid')
  }
  if (!/^[1-9]\d*$/u.test(context.runId)) {
    throw new Error('Automatic release source run ID is invalid')
  }
  return {
    ...context,
    owner: match.groups.owner,
    repo: match.groups.repo
  }
}

export function createReleaseBranchName(version, sourceSha) {
  const normalizedVersion = parseReleaseVersion(version).version
  if (!shaPattern.test(sourceSha)) {
    throw new Error(`Invalid release source SHA: ${sourceSha}`)
  }
  return `automation/release-v${normalizedVersion}-${sourceSha.slice(0, 12)}`
}

export function getRemoteTagState(tag, runGit = readGit) {
  let objectId = ''
  try {
    objectId = runGit([
      'ls-remote',
      '--exit-code',
      '--refs',
      'origin',
      `refs/tags/${tag}`
    ])
      .split(/\s+/u)[0]
      .trim()
  } catch {
    return { commit: '', objectId: '' }
  }

  try {
    const commit = runGit([
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/tags/${tag}^{}`
    ])
      .split(/\s+/u)[0]
      .trim()
    return { commit, objectId }
  } catch {
    return { commit: objectId, objectId }
  }
}

export function assertAutomationPullRequest({
  branch,
  pullRequest,
  releaseSha,
  repository
}) {
  if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) {
    throw new Error('Automatic release PR has an invalid number')
  }
  if (!botLogins.has(pullRequest.user?.login)) {
    throw new Error(
      `Automatic release PR has unexpected author ${pullRequest.user?.login ?? 'unknown'}`
    )
  }
  if (
    pullRequest.base?.ref !== 'main' ||
    pullRequest.base?.repo?.full_name !== repository
  ) {
    throw new Error('Automatic release PR has an unexpected base')
  }
  if (
    pullRequest.head?.ref !== branch ||
    pullRequest.head?.repo?.full_name !== repository ||
    pullRequest.head?.sha !== releaseSha
  ) {
    throw new Error('Automatic release PR has an unexpected head')
  }
  return pullRequest
}

export function assertRecoveredReleasePullRequest({
  mergeSha,
  pullRequests,
  releaseSha,
  repository,
  sourceSha,
  version
}) {
  const normalizedMergeSha = requireSha(
    mergeSha,
    'recovered release merge SHA'
  )
  if (!Array.isArray(pullRequests)) {
    throw new Error('Associated release pull requests must be an array')
  }
  const matching = pullRequests.filter(
    pullRequest => pullRequest.merge_commit_sha === normalizedMergeSha
  )
  if (matching.length !== 1) {
    throw new Error(
      `Recovered release merge ${normalizedMergeSha} must have exactly one associated pull request`
    )
  }
  const pullRequest = assertAutomationPullRequest({
    branch: createReleaseBranchName(version, sourceSha),
    pullRequest: matching[0],
    releaseSha,
    repository
  })
  if (
    pullRequest.state !== 'closed' ||
    !pullRequest.merged_at ||
    pullRequest.merge_commit_sha !== normalizedMergeSha
  ) {
    throw new Error(
      `Recovered release PR #${pullRequest.number} is not merged as ${normalizedMergeSha}`
    )
  }
  return pullRequest
}

export function createMergePullRequestArguments({
  branch,
  number,
  releaseSha,
  repository,
  tag
}) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid release pull request number: ${number}`)
  }
  if (!shaPattern.test(releaseSha)) {
    throw new Error(`Invalid release commit SHA: ${releaseSha}`)
  }
  return [
    'api',
    '--method',
    'PUT',
    `repos/${repository}/pulls/${number}/merge`,
    '-f',
    `sha=${releaseSha}`,
    '-f',
    'merge_method=merge',
    '-f',
    `commit_title=Merge pull request #${number} from ${branch}`,
    '-f',
    `commit_message=Merge automatic release ${tag}`
  ]
}

function requireSha(value, label) {
  const sha = String(value ?? '')
  if (!shaPattern.test(sha)) {
    throw new Error(`Invalid ${label}: ${sha || 'missing'}`)
  }
  return sha
}

export function resolveReleaseMergeCommit({
  merge,
  pullRequest
}) {
  const mergeSha = pullRequest.merged_at
    ? pullRequest.merge_commit_sha
    : merge?.sha
  if (!pullRequest.merged_at && merge?.merged !== true) {
    throw new Error(
      `GitHub did not merge automatic release PR #${pullRequest.number}`
    )
  }
  return requireSha(mergeSha, 'release merge commit SHA')
}

export function inspectReleaseMergeCommit({
  isAncestor = isGitAncestor,
  mergeSha,
  releaseSha,
  runGit = readGit,
  tag
}) {
  const normalizedMergeSha = requireSha(mergeSha, 'release merge commit SHA')
  const normalizedReleaseSha = requireSha(
    releaseSha,
    'release commit SHA'
  )
  const parents = runGit([
    'rev-list',
    '--parents',
    '-n',
    '1',
    normalizedMergeSha
  ])
    .trim()
    .split(/\s+/u)
  if (
    parents.length !== 3 ||
    parents[0] !== normalizedMergeSha ||
    parents[2] !== normalizedReleaseSha
  ) {
    throw new Error(
      `Release merge ${normalizedMergeSha} must have the release commit as its second parent`
    )
  }

  const baseSha = requireSha(parents[1], 'release merge base SHA')
  const releaseParents = runGit([
    'rev-list',
    '--parents',
    '-n',
    '1',
    normalizedReleaseSha
  ])
    .trim()
    .split(/\s+/u)
  if (
    releaseParents.length !== 2 ||
    releaseParents[0] !== normalizedReleaseSha
  ) {
    throw new Error(
      `Release commit ${normalizedReleaseSha} must have exactly one parent`
    )
  }
  const sourceSha = requireSha(
    releaseParents[1],
    'release source SHA'
  )
  if (!isAncestor(sourceSha, baseSha)) {
    throw new Error(
      `Release source ${sourceSha} must be an ancestor of merge base ${baseSha}`
    )
  }
  const releaseSubject = runGit([
    'log',
    '-1',
    '--format=%s',
    normalizedReleaseSha
  ])
  if (releaseSubject !== `chore(release): cut ${tag}`) {
    throw new Error(`Unexpected release commit subject: ${releaseSubject}`)
  }

  const mergedFiles = runGit([
    'diff',
    '--name-only',
    baseSha,
    normalizedMergeSha
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  assertReleaseChangedFiles(mergedFiles)
  const releaseFiles = runGit([
    'diff',
    '--name-only',
    sourceSha,
    normalizedReleaseSha
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  assertReleaseChangedFiles(releaseFiles)

  const mergedManifestBlob = runGit([
    'rev-parse',
    '--verify',
    `${normalizedMergeSha}:package.json`
  ])
  const releaseManifestBlob = runGit([
    'rev-parse',
    '--verify',
    `${normalizedReleaseSha}:package.json`
  ])
  if (mergedManifestBlob !== releaseManifestBlob) {
    throw new Error(
      'Release merge package.json must match the release commit exactly'
    )
  }
  const mergedChangelogBlob = runGit([
    'rev-parse',
    '--verify',
    `${normalizedMergeSha}:CHANGELOG.md`
  ])
  const releaseChangelogBlob = runGit([
    'rev-parse',
    '--verify',
    `${normalizedReleaseSha}:CHANGELOG.md`
  ])
  if (mergedChangelogBlob !== releaseChangelogBlob) {
    throw new Error(
      'Release merge CHANGELOG.md must match the release commit exactly'
    )
  }

  const mergedManifestText = runGit([
    'show',
    `${normalizedMergeSha}:package.json`
  ])
  const mergedChangelog = runGit([
    'show',
    `${normalizedMergeSha}:CHANGELOG.md`
  ])
  const releaseChangelog = runGit([
    'show',
    `${normalizedReleaseSha}:CHANGELOG.md`
  ])
  const currentManifest = JSON.parse(mergedManifestText)
  const mergedVersion = assertReleasePayload({
    changelog: mergedChangelog,
    currentManifest,
    previousManifest: JSON.parse(
      runGit(['show', `${baseSha}:package.json`])
    )
  })
  const releaseVersion = assertReleasePayload({
    changelog: releaseChangelog,
    currentManifest,
    previousManifest: JSON.parse(
      runGit(['show', `${sourceSha}:package.json`])
    )
  })
  if (mergedVersion !== releaseVersion || `v${releaseVersion}` !== tag) {
    throw new Error(
      `Release tag ${tag} does not match package.json version ${releaseVersion}`
    )
  }
  return {
    baseSha,
    mergeSha: normalizedMergeSha,
    releaseSha: normalizedReleaseSha,
    sourceSha,
    version: releaseVersion
  }
}

function waitSynchronously(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

export function waitForReleaseBaseCi({
  assertCi = assertRemoteCiSuccess,
  attempts = releaseBaseCiPollAttempts,
  baseSha,
  context,
  wait = waitSynchronously
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error(`Invalid release CI poll attempts: ${attempts}`)
  }
  const expectedRunId =
    baseSha === context.sourceSha ? context.runId : undefined
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return assertCi({
        expectedRunId,
        head: baseSha
      })
    } catch (error) {
      lastError = error
      const message = error instanceof Error ? error.message : String(error)
      if (
        !message.includes('needs a successful completed CI run on main') ||
        attempt === attempts
      ) {
        throw error
      }
      wait(releaseBaseCiPollIntervalMs)
    }
  }
  throw lastError
}

function verifyAutomaticReleaseTag({
  context,
  tag
}) {
  const tagType = readGit([
    'cat-file',
    '-t',
    `refs/tags/${tag}`
  ])
  if (tagType !== 'tag') {
    throw new Error(`Release tag ${tag} must be annotated`)
  }
  const tagCommit = readGit([
    'rev-list',
    '-n',
    '1',
    `refs/tags/${tag}`
  ])
  const parents = readGit([
    'rev-list',
    '--parents',
    '-n',
    '1',
    tagCommit
  ])
    .trim()
    .split(/\s+/u)
  if (parents.length !== 3) {
    const legacy = verifyPublishedReleaseTag({ tag })
    return {
      ...legacy,
      releaseSha: legacy.tagCommit,
      sourceSha: legacy.parent,
      version: tag.slice(1)
    }
  }

  const releaseMerge = inspectReleaseMergeCommit({
    mergeSha: tagCommit,
    releaseSha: parents[2],
    tag
  })
  const remoteMain = readGit([
    'rev-parse',
    '--verify',
    'origin/main^{commit}'
  ])
  if (!isGitAncestor(tagCommit, remoteMain)) {
    throw new Error(
      `Release tag ${tag} must be reachable from remote main`
    )
  }
  const ci = waitForReleaseBaseCi({
    attempts: 1,
    baseSha: releaseMerge.baseSha,
    context
  })
  return {
    parent: releaseMerge.baseSha,
    releaseSha: releaseMerge.releaseSha,
    repository: ci.repository,
    runId: ci.runId,
    sourceSha: releaseMerge.sourceSha,
    tag,
    tagCommit,
    version: releaseMerge.version
  }
}

export function findPendingReleaseMerge({
  getTagState = getRemoteTagState,
  isAncestor = isGitAncestor,
  runGit = readGit
} = {}) {
  const baselineTag = runGit([
    'tag',
    '--merged',
    'origin/main',
    '--list',
    'v*',
    '--sort=-version:refname'
  ])
    .split(/\r?\n/u)
    .map(tag => tag.trim())
    .find(tag => /^v\d+\.\d+\.\d+$/u.test(tag)) ?? ''
  const revision = baselineTag
    ? `${baselineTag}..origin/main`
    : 'origin/main'
  const mergeCommits = runGit([
    'rev-list',
    '--first-parent',
    '--merges',
    revision
  ])
    .split(/\r?\n/u)
    .map(commit => commit.trim())
    .filter(Boolean)
  const pending = []

  for (const mergeSha of mergeCommits) {
    const parents = runGit([
      'rev-list',
      '--parents',
      '-n',
      '1',
      mergeSha
    ])
      .trim()
      .split(/\s+/u)
    if (parents.length !== 3 || parents[0] !== mergeSha) {
      continue
    }
    const releaseSha = parents[2]
    const subject = runGit([
      'log',
      '-1',
      '--format=%s',
      releaseSha
    ])
    const match = subject.match(
      /^chore\(release\): cut (?<tag>v\d+\.\d+\.\d+)$/u
    )
    if (!match?.groups) {
      continue
    }

    const tagState = getTagState(match.groups.tag, runGit)
    if (tagState.commit) {
      if (tagState.commit !== mergeSha) {
        throw new Error(
          `Release tag ${match.groups.tag} points to ${tagState.commit}, expected ${mergeSha}`
        )
      }
      continue
    }
    pending.push({
      ...inspectReleaseMergeCommit({
        isAncestor,
        mergeSha,
        releaseSha,
        runGit,
        tag: match.groups.tag
      }),
      tag: match.groups.tag
    })
  }

  if (pending.length > 1) {
    throw new Error('Multiple untagged release merges require recovery')
  }
  return pending[0] ?? null
}

function remoteBranchCommit(branch) {
  const output = readGit([
    'ls-remote',
    '--heads',
    'origin',
    `refs/heads/${branch}`
  ])
  return output ? output.split(/\s+/u)[0] : ''
}

export function deleteRemoteReleaseBranch({
  branch,
  expectedSha,
  getRemoteCommit = remoteBranchCommit,
  push = writeGit
}) {
  const normalizedExpectedSha = requireSha(
    expectedSha,
    'expected release branch SHA'
  )
  if (
    !/^automation\/release-v\d+\.\d+\.\d+-[0-9a-f]{12}$/iu.test(branch)
  ) {
    throw new Error(`Invalid automatic release branch: ${branch}`)
  }
  const remoteCommit = getRemoteCommit(branch)
  if (!remoteCommit) {
    return false
  }
  if (remoteCommit !== normalizedExpectedSha) {
    throw new Error(
      `Remote branch ${branch} points to ${remoteCommit}, expected ${normalizedExpectedSha}`
    )
  }
  push([
    'push',
    'origin',
    `--force-with-lease=refs/heads/${branch}:${normalizedExpectedSha}`,
    `:refs/heads/${branch}`
  ])
  return true
}

function listReleasePullRequests(context, branch) {
  return readGhJson([
    'api',
    '--method',
    'GET',
    `repos/${context.repository}/pulls`,
    '-f',
    'state=all',
    '-f',
    `head=${context.owner}:${branch}`,
    '-f',
    'base=main',
    '-f',
    'per_page=100'
  ])
}

function listPullRequestsAssociatedWithCommit(context, mergeSha) {
  return readGhJson([
    'api',
    '--method',
    'GET',
    `repos/${context.repository}/commits/${mergeSha}/pulls`,
    '-f',
    'per_page=100'
  ])
}

function createOrRecoverPullRequest({
  branch,
  context,
  releaseSha,
  tag
}) {
  const candidates = listReleasePullRequests(context, branch)
  const matching = candidates.filter(pullRequest =>
    pullRequest.head?.ref === branch &&
    pullRequest.head?.repo?.full_name === context.repository
  )
  if (matching.length > 1) {
    throw new Error(`Multiple pull requests use automatic branch ${branch}`)
  }

  let pullRequest = matching[0]
  if (!pullRequest) {
    pullRequest = writeGhJson([
      'api',
      '--method',
      'POST',
      `repos/${context.repository}/pulls`,
      '-f',
      `title=chore(release): cut ${tag}`,
      '-f',
      `head=${branch}`,
      '-f',
      'base=main',
      '-f',
      `body=Automated release from CI run ${context.runId} at ${context.sourceSha}.`
    ])
  } else if (pullRequest.state === 'closed' && !pullRequest.merged_at) {
    assertAutomationPullRequest({
      branch,
      pullRequest,
      releaseSha,
      repository: context.repository
    })
    pullRequest = writeGhJson([
      'api',
      '--method',
      'PATCH',
      `repos/${context.repository}/pulls/${pullRequest.number}`,
      '-f',
      'state=open'
    ])
  }
  return assertAutomationPullRequest({
    branch,
    pullRequest,
    releaseSha,
    repository: context.repository
  })
}

function getStableTagsMergedIntoMain() {
  return readGit([
    'tag',
    '--merged',
    'origin/main',
    '--list',
    'v*',
    '--sort=-version:refname'
  ])
    .split(/\r?\n/u)
    .map(tag => tag.trim())
    .filter(tag => /^v\d+\.\d+\.\d+$/u.test(tag))
}

export function releaseBaseCoversSource({
  baseSha,
  isAncestor = isGitAncestor,
  sourceSha
}) {
  const normalizedBaseSha = requireSha(baseSha, 'release base SHA')
  const normalizedSourceSha = requireSha(sourceSha, 'release source SHA')
  return isAncestor(normalizedSourceSha, normalizedBaseSha)
}

function findReleaseCoveringSource(sourceSha) {
  for (const tag of getStableTagsMergedIntoMain()) {
    const tagCommit = readGit(['rev-list', '-n', '1', tag])
    const parent = readGit([
      'rev-parse',
      '--verify',
      `${tagCommit}^1^{commit}`
    ])
    if (releaseBaseCoversSource({ baseSha: parent, sourceSha })) {
      return { parent, tag, tagCommit }
    }
  }
  return null
}

export function createReleaseCommitArguments({ tag }) {
  const releaseTag = normalizeReleaseTag(tag)
  return [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    `chore(release): cut ${releaseTag}`,
    '-m',
    '[skip ci]'
  ]
}

function createReleaseCommit({ context, plan }) {
  writeGit(['add', '--', ...plan.changedFiles])
  const stagedFiles = readGit([
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMR'
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  assertReleaseChangedFiles(stagedFiles)

  const sourceTimestamp = readGit([
    'show',
    '-s',
    '--format=%cI',
    context.sourceSha
  ])
  writeGit(createReleaseCommitArguments({ tag: plan.tag }), {
    env: {
      GIT_AUTHOR_DATE: sourceTimestamp,
      GIT_COMMITTER_DATE: sourceTimestamp
    }
  })
  const releaseSha = readGit(['rev-parse', '--verify', 'HEAD^{commit}'])
  const parent = readGit([
    'rev-parse',
    '--verify',
    'HEAD^1^{commit}'
  ])
  if (parent !== context.sourceSha) {
    throw new Error(
      `Release commit parent ${parent} does not match source ${context.sourceSha}`
    )
  }
  const committedFiles = readGit([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    releaseSha
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  assertReleaseChangedFiles(committedFiles)
  const currentManifest = JSON.parse(
    readGit(['show', `${releaseSha}:package.json`])
  )
  const previousManifest = JSON.parse(
    readGit(['show', `${parent}:package.json`])
  )
  const changelog = readGit(['show', `${releaseSha}:CHANGELOG.md`])
  assertReleasePayload({
    changelog,
    currentManifest,
    previousManifest
  })
  return releaseSha
}

export function ensureReleaseBranch(branch, releaseSha, {
  getRemoteCommit = remoteBranchCommit,
  push = writeGit
} = {}) {
  const normalizedReleaseSha = requireSha(
    releaseSha,
    'release branch SHA'
  )
  const remoteCommit = getRemoteCommit(branch)
  if (remoteCommit && remoteCommit !== normalizedReleaseSha) {
    throw new Error(
      `Remote branch ${branch} points to ${remoteCommit}, expected ${normalizedReleaseSha}`
    )
  }
  if (!remoteCommit) {
    push([
      'push',
      'origin',
      `--force-with-lease=refs/heads/${branch}:`,
      `${normalizedReleaseSha}:refs/heads/${branch}`
    ])
  }
}

function closeStalePullRequest({
  branch,
  context,
  pullRequest,
  releaseSha
}) {
  writeGhJson([
    'api',
    '--method',
    'PATCH',
    `repos/${context.repository}/pulls/${pullRequest.number}`,
    '-f',
    'state=closed'
  ])
  deleteRemoteReleaseBranch({
    branch,
    expectedSha: releaseSha
  })
}

export function assertRemoteTagMatches({
  localObjectId,
  remoteTag,
  tag,
  targetSha
}) {
  const normalizedLocalObjectId = requireSha(
    localObjectId,
    'local release tag object ID'
  )
  const normalizedRemoteCommit = requireSha(
    remoteTag.commit,
    'remote release tag commit'
  )
  const normalizedRemoteObjectId = requireSha(
    remoteTag.objectId,
    'remote release tag object ID'
  )
  if (normalizedRemoteCommit !== targetSha) {
    throw new Error(
      `Remote tag ${tag} points to ${normalizedRemoteCommit}, expected ${targetSha}`
    )
  }
  if (normalizedRemoteObjectId !== normalizedLocalObjectId) {
    throw new Error(
      `Remote tag ${tag} object ${normalizedRemoteObjectId} does not match local object ${normalizedLocalObjectId}`
    )
  }
  return remoteTag
}

function createAndPushTag({ sourceSha, tag, targetSha }) {
  let localTagCommit = ''
  try {
    localTagCommit = readGit(['rev-list', '-n', '1', tag])
  } catch {
    const sourceTimestamp = readGit([
      'show',
      '-s',
      '--format=%cI',
      sourceSha
    ])
    writeGit(
      [
        '-c',
        'user.name=github-actions[bot]',
        '-c',
        'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        '-c',
        'tag.gpgSign=false',
        'tag',
        '-a',
        tag,
        '-m',
        tag,
        targetSha
      ],
      {
        env: {
          GIT_COMMITTER_DATE: sourceTimestamp
        }
      }
    )
    localTagCommit = readGit(['rev-list', '-n', '1', tag])
  }
  if (localTagCommit !== targetSha) {
    throw new Error(
      `Local tag ${tag} points to ${localTagCommit}, expected ${targetSha}`
    )
  }
  const localTagType = readGit([
    'cat-file',
    '-t',
    `refs/tags/${tag}`
  ])
  if (localTagType !== 'tag') {
    throw new Error(`Release tag ${tag} must be annotated`)
  }
  const localObjectId = readGit([
    'rev-parse',
    '--verify',
    `refs/tags/${tag}`
  ])

  const remoteTag = getRemoteTagState(tag, readGit)
  if (remoteTag.commit) {
    assertRemoteTagMatches({
      localObjectId,
      remoteTag,
      tag,
      targetSha
    })
  } else {
    writeGit(['push', 'origin', `refs/tags/${tag}`])
  }
  assertRemoteTagMatches({
    localObjectId,
    remoteTag: getRemoteTagState(tag, readGit),
    tag,
    targetSha
  })
}

function releaseBranchFor({
  sourceSha,
  version
}) {
  return createReleaseBranchName(version, sourceSha)
}

function cleanupReleaseBranch(release) {
  deleteRemoteReleaseBranch({
    branch: releaseBranchFor(release),
    expectedSha: release.releaseSha
  })
}

function completeReleaseMerge({
  context,
  releaseMerge,
  tag
}) {
  waitForReleaseBaseCi({
    baseSha: releaseMerge.baseSha,
    context
  })
  createAndPushTag({
    sourceSha: releaseMerge.sourceSha,
    tag,
    targetSha: releaseMerge.mergeSha
  })
  verifyAutomaticReleaseTag({
    context,
    tag
  })
  syncReleaseNotes([
    '--repo',
    context.repository,
    '--tag',
    tag,
    '--expected-commit',
    releaseMerge.mergeSha,
    '--create-if-missing'
  ])
  cleanupReleaseBranch(releaseMerge)
}

export function runAutomaticRelease() {
  const context = parseAutomaticReleaseContext()
  writeGit(['fetch', 'origin', 'main', '--tags'])
  const checkoutHead = readGit(['rev-parse', '--verify', 'HEAD^{commit}'])
  if (checkoutHead !== context.sourceSha) {
    throw new Error(
      `Workflow checkout ${checkoutHead} does not match ${context.sourceSha}`
    )
  }
  const status = readGit([
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ])
  if (status) {
    throw new Error('Automatic release requires a clean checkout')
  }

  assertRemoteCiSuccess({
    expectedRunId: context.runId,
    head: context.sourceSha
  })
  const coveringRelease = findReleaseCoveringSource(context.sourceSha)
  if (coveringRelease) {
    const verifiedRelease = verifyAutomaticReleaseTag({
      context,
      tag: coveringRelease.tag
    })
    syncReleaseNotes([
      '--repo',
      context.repository,
      '--tag',
      coveringRelease.tag,
      '--expected-commit',
      coveringRelease.tagCommit,
      '--create-if-missing'
    ])
    cleanupReleaseBranch(verifiedRelease)
    console.log(
      `Source ${context.sourceSha} is already covered by ${coveringRelease.tag}.`
    )
    return { status: 'already-released', tag: coveringRelease.tag }
  }

  let recoveredRelease
  const pendingRelease = findPendingReleaseMerge()
  if (pendingRelease) {
    assertRecoveredReleasePullRequest({
      mergeSha: pendingRelease.mergeSha,
      pullRequests: listPullRequestsAssociatedWithCommit(
        context,
        pendingRelease.mergeSha
      ),
      releaseSha: pendingRelease.releaseSha,
      repository: context.repository,
      sourceSha: pendingRelease.sourceSha,
      version: pendingRelease.version
    })
    completeReleaseMerge({
      context,
      releaseMerge: pendingRelease,
      tag: pendingRelease.tag
    })
    console.log(
      `Recovered automatic release ${pendingRelease.tag} from merge ${pendingRelease.mergeSha}.`
    )
    if (
      releaseBaseCoversSource({
        baseSha: pendingRelease.baseSha,
        sourceSha: context.sourceSha
      })
    ) {
      return {
        status: 'recovered',
        tag: pendingRelease.tag
      }
    }
    recoveredRelease = pendingRelease
    console.log(
      `Source ${context.sourceSha} contains commits after ${pendingRelease.tag}; continuing release planning.`
    )
  }

  const plan = prepareReleaseWorkingTree({
    sourceSha: context.sourceSha
  })
  for (const subject of plan.ignoredCommits) {
    console.warn(`Ignored non-conventional commit: ${subject}`)
  }
  if (plan.status === 'skipped') {
    console.log('No release-worthy commits since the latest tag.')
    return recoveredRelease
      ? { status: 'recovered', tag: recoveredRelease.tag }
      : { status: 'skipped' }
  }

  const releaseSha = createReleaseCommit({ context, plan })
  const branch = createReleaseBranchName(plan.version, context.sourceSha)
  ensureReleaseBranch(branch, releaseSha)
  const pullRequest = createOrRecoverPullRequest({
    branch,
    context,
    releaseSha,
    tag: plan.tag
  })

  let merge
  if (!pullRequest.merged_at) {
    writeGit(['fetch', 'origin', 'main'])
    const currentMain = readGit([
      'rev-parse',
      '--verify',
      'origin/main^{commit}'
    ])
    if (currentMain !== context.sourceSha) {
      closeStalePullRequest({
        branch,
        context,
        pullRequest,
        releaseSha
      })
      console.log(
        `Main advanced from ${context.sourceSha} to ${currentMain}; a newer CI run will prepare the release.`
      )
      return { status: 'stale' }
    }
    merge = writeGhJson(
      createMergePullRequestArguments({
        branch,
        number: pullRequest.number,
        releaseSha,
        repository: context.repository,
        tag: plan.tag
      })
    )
  }
  const mergeSha = resolveReleaseMergeCommit({ merge, pullRequest })

  writeGit(['fetch', 'origin', 'main'])
  const remoteMain = readGit([
    'rev-parse',
    '--verify',
    'origin/main^{commit}'
  ])
  if (!isGitAncestor(mergeSha, remoteMain)) {
    throw new Error(
      `Release merge ${mergeSha} is not reachable from remote main ${remoteMain}`
    )
  }
  const releaseMerge = inspectReleaseMergeCommit({
    mergeSha,
    releaseSha,
    tag: plan.tag
  })
  completeReleaseMerge({
    context,
    releaseMerge,
    tag: plan.tag
  })
  console.log(`Automatic release ${plan.tag} completed.`)
  return {
    pullRequest: pullRequest.number,
    status: 'released',
    tag: plan.tag
  }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  try {
    runAutomaticRelease()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
