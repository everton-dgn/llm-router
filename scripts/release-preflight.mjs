import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const runGitCommand = args =>
  execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim()
const runGhCommand = args =>
  execFileSync('gh', args, {
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

function inspectReleaseCheckout(runGit) {
  const branch = requireGitOutput(
    runGit,
    ['branch', '--show-current'],
    'the current branch'
  )
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all'])
  if (typeof status !== 'string') {
    throw new Error('Cannot inspect the release working tree')
  }
  if (branch !== 'main') {
    throw new Error(`Release commands require branch main, current: ${branch}`)
  }
  if (status.trim()) {
    throw new Error('Release commands require a clean working tree and index')
  }

  const head = requireGitOutput(
    runGit,
    ['rev-parse', '--verify', 'HEAD^{commit}'],
    'the current HEAD commit'
  )
  const originMain = requireGitOutput(
    runGit,
    ['rev-parse', '--verify', 'origin/main^{commit}'],
    'origin/main'
  )
  const advertisedMain = requireGitOutput(
    runGit,
    ['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/main'],
    'the main branch advertised by origin'
  ).split(/\s+/)[0]

  if (!/^[0-9a-f]{40,64}$/i.test(advertisedMain)) {
    throw new Error('Origin returned an invalid main commit')
  }
  if (originMain !== advertisedMain) {
    throw new Error(
      `Local origin/main ${originMain} is stale; origin advertises ${advertisedMain}`
    )
  }
  return { advertisedMain, branch, head, originMain }
}

export function assertReleaseSourceReady({ runGit = runGitCommand } = {}) {
  const state = inspectReleaseCheckout(runGit)
  if (state.head !== state.advertisedMain) {
    throw new Error(
      `Release source must match origin/main exactly: HEAD ${state.head}, origin/main ${state.advertisedMain}`
    )
  }
  return state
}

export function assertReleasePushReady({
  expectedSubject,
  runGit = runGitCommand
}) {
  const state = inspectReleaseCheckout(runGit)
  const parent = requireGitOutput(
    runGit,
    ['rev-parse', '--verify', 'HEAD^1^{commit}'],
    'the release commit parent'
  )
  if (parent !== state.advertisedMain) {
    throw new Error(
      `Release commit must be directly based on origin/main ${state.advertisedMain}`
    )
  }
  const subject = requireGitOutput(
    runGit,
    ['log', '-1', '--format=%s'],
    'the release commit subject'
  )
  if (subject !== expectedSubject) {
    throw new Error(`Unexpected release commit subject: ${subject}`)
  }
  const changedFiles = runGit([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    'HEAD'
  ])
    .split(/\r?\n/u)
    .map(file => file.trim())
    .filter(Boolean)
  if (
    changedFiles.length !== 1 ||
    changedFiles[0] !== 'package.json'
  ) {
    throw new Error(
      `Release commit must change only package.json, received: ${changedFiles.join(', ') || 'no files'}`
    )
  }
  return state
}

export function parseGitHubRepository(remoteUrl) {
  const match = String(remoteUrl)
    .trim()
    .match(/github\.com(?::|\/)(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u)
  if (!match?.groups) {
    throw new Error(`Cannot derive a GitHub repository from ${remoteUrl}`)
  }
  return `${match.groups.owner}/${match.groups.repo}`
}

export function assertRemoteCiSuccess({
  head,
  runGh = runGhCommand,
  runGit = runGitCommand
}) {
  if (!/^[0-9a-f]{40,64}$/iu.test(head)) {
    throw new Error(`Cannot verify CI for invalid commit ${head}`)
  }
  const repository = parseGitHubRepository(
    requireGitOutput(
      runGit,
      ['remote', 'get-url', 'origin'],
      'the origin URL'
    )
  )
  const response = JSON.parse(
    runGh([
      'api',
      '--method',
      'GET',
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${head}&status=completed&per_page=100`
    ])
  )
  const successfulRun = response.workflow_runs?.find(
    run =>
      run.head_sha === head &&
      run.head_branch === 'main' &&
      ['push', 'workflow_dispatch'].includes(run.event) &&
      run.conclusion === 'success'
  )
  if (!successfulRun) {
    throw new Error(
      `Commit ${head} needs a successful completed CI run on main before release`
    )
  }
  return {
    repository,
    runId: successfulRun.id
  }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  try {
    const state = assertReleaseSourceReady()
    console.log(`Release preflight passed on main at ${state.head}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
