import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertRemoteCiSuccess,
  assertReleasePushReady,
  assertReleaseSourceReady,
  parseGitHubRepository
} from './release-preflight.mjs'

const gitRunner =
  ({
    advertised = 'a'.repeat(40),
    branch = 'main',
    head = advertised,
    originMain = advertised,
    parent = advertised,
    status = '',
    subject = 'chore(release): cut v0.1.0',
    changedFiles = 'package.json'
  } = {}) =>
  args => {
    const command = args.join(' ')
    if (command === 'branch --show-current') return branch
    if (command === 'status --porcelain=v1 --untracked-files=all') return status
    if (command === 'rev-parse --verify HEAD^{commit}') return head
    if (command === 'rev-parse --verify origin/main^{commit}') return originMain
    if (command === 'ls-remote --exit-code --heads origin refs/heads/main') {
      return `${advertised}\trefs/heads/main`
    }
    if (command === 'rev-parse --verify HEAD^1^{commit}') return parent
    if (command === 'log -1 --format=%s') return subject
    if (
      command ===
      'diff-tree --no-commit-id --name-only -r HEAD'
    ) {
      return changedFiles
    }
    throw new Error(`Unexpected git call: ${command}`)
  }

test('requires clean main synchronized with the live remote', () => {
  assert.equal(assertReleaseSourceReady({ runGit: gitRunner() }).branch, 'main')
  assert.throws(
    () =>
      assertReleaseSourceReady({ runGit: gitRunner({ branch: 'feat/x' }) }),
    /require branch main/
  )
  assert.throws(
    () =>
      assertReleaseSourceReady({
        runGit: gitRunner({ status: '?? local.txt' })
      }),
    /clean working tree/
  )
  assert.throws(
    () =>
      assertReleaseSourceReady({
        runGit: gitRunner({
          advertised: 'b'.repeat(40),
          head: 'a'.repeat(40),
          originMain: 'a'.repeat(40)
        })
      }),
    /stale/
  )
})

test('accepts only the generated release commit above origin/main', () => {
  const originMain = 'a'.repeat(40)
  const head = 'b'.repeat(40)
  assert.equal(
    assertReleasePushReady({
      expectedSubject: 'chore(release): cut v0.1.0',
      runGit: gitRunner({ head, parent: originMain, originMain })
    }).head,
    head
  )
  assert.throws(
    () =>
      assertReleasePushReady({
        expectedSubject: 'chore(release): cut v0.1.0',
        runGit: gitRunner({
          head,
          originMain,
          parent: 'c'.repeat(40)
        })
      }),
    /directly based/
  )
  assert.throws(
    () =>
      assertReleasePushReady({
        expectedSubject: 'chore(release): cut v0.1.0',
        runGit: gitRunner({
          changedFiles: 'package.json\nopencode/opencode.jsonc',
          head,
          originMain,
          parent: originMain
        })
      }),
    /change only package.json/
  )
})

test('requires successful remote CI for the exact main commit', () => {
  const head = 'a'.repeat(40)
  const runGit = args => {
    assert.deepEqual(args, ['remote', 'get-url', 'origin'])
    return 'git@github.com:everton-dgn/llm-router.git'
  }
  const runGh = args => {
    assert.match(args.at(-1), new RegExp(`head_sha=${head}`))
    return JSON.stringify({
      workflow_runs: [
        {
          conclusion: 'success',
          event: 'push',
          head_branch: 'main',
          head_sha: head,
          id: 123
        }
      ]
    })
  }
  assert.deepEqual(assertRemoteCiSuccess({ head, runGh, runGit }), {
    repository: 'everton-dgn/llm-router',
    runId: 123
  })
  assert.throws(
    () =>
      assertRemoteCiSuccess({
        head,
        runGh: () => JSON.stringify({ workflow_runs: [] }),
        runGit
      }),
    /needs a successful completed CI/
  )
})

test('parses supported GitHub origin URLs', () => {
  assert.equal(
    parseGitHubRepository('git@github.com:everton-dgn/llm-router.git'),
    'everton-dgn/llm-router'
  )
  assert.equal(
    parseGitHubRepository('https://github.com/everton-dgn/llm-router.git'),
    'everton-dgn/llm-router'
  )
})
