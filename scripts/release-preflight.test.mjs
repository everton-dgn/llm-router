import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertRemoteCiSuccess,
  assertReleaseSourceReady,
  parseGitHubRepository
} from './release-preflight.mjs'

const gitRunner =
  ({
    advertised = 'a'.repeat(40),
    branch = 'main',
    head = advertised,
    originMain = advertised,
    status = ''
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
  assert.deepEqual(
    assertRemoteCiSuccess({
      expectedRunId: '123',
      head,
      runGh: () =>
        JSON.stringify({
          workflow_runs: [
            {
              conclusion: 'success',
              event: 'push',
              head_branch: 'main',
              head_sha: head,
              id: 456
            },
            {
              conclusion: 'success',
              event: 'push',
              head_branch: 'main',
              head_sha: head,
              id: 123
            }
          ]
        }),
      runGit
    }),
    {
      repository: 'everton-dgn/llm-router',
      runId: 123
    }
  )
  assert.throws(
    () =>
      assertRemoteCiSuccess({
        expectedRunId: '999',
        head,
        runGh,
        runGit
      }),
    /needs a successful completed CI/
  )
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
