import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyPublishedReleaseTag } from './verify-release-tag.mjs'

const releaseCommit = 'b'.repeat(40)
const sourceCommit = 'a'.repeat(40)
const mainCommit = 'c'.repeat(40)
const changelog = [
  '# Changelog',
  '',
  '## 0.2.0 - 2026-07-23',
  '',
  '- Release notes.',
  ''
].join('\n')

function releaseGit(overrides = {}) {
  const responses = new Map([
    ['cat-file -t refs/tags/v0.2.0', 'tag'],
    ['rev-list -n 1 refs/tags/v0.2.0', releaseCommit],
    [
      'ls-remote --exit-code --heads origin refs/heads/main',
      `${mainCommit}\trefs/heads/main`
    ],
    [`merge-base ${releaseCommit} ${mainCommit}`, releaseCommit],
    [
      `log -1 --format=%s ${releaseCommit}`,
      'chore(release): cut v0.2.0'
    ],
    [
      `diff-tree --no-commit-id --name-only -r ${releaseCommit}`,
      'package.json'
    ],
    [
      `rev-parse --verify ${releaseCommit}^1^{commit}`,
      sourceCommit
    ],
    [
      `show ${releaseCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.2.0' })
    ],
    [
      `show ${sourceCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.1.0' })
    ],
    [`show ${releaseCommit}:CHANGELOG.md`, changelog]
  ])
  for (const [key, value] of Object.entries(overrides)) responses.set(key, value)
  return args => {
    const key = args.join(' ')
    if (!responses.has(key)) throw new Error(`Unexpected git call: ${key}`)
    return responses.get(key)
  }
}

test('accepts only the annotated release commit at remote main with source CI', () => {
  const ciHeads = []
  const result = verifyPublishedReleaseTag({
    tag: 'v0.2.0',
    runGit: releaseGit(),
    assertCi: ({ head }) => {
      ciHeads.push(head)
      return { repository: 'owner/repo', runId: 42 }
    }
  })

  assert.deepEqual(ciHeads, [sourceCommit])
  assert.deepEqual(result, {
    parent: sourceCommit,
    repository: 'owner/repo',
    runId: 42,
    tag: 'v0.2.0',
    tagCommit: releaseCommit
  })
})

test('rejects lightweight tags and tags outside remote main history', () => {
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        'cat-file -t refs/tags/v0.2.0': 'commit'
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /must be annotated/
  )
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        'ls-remote --exit-code --heads origin refs/heads/main':
          `${sourceCommit}\trefs/heads/main`,
        [`merge-base ${releaseCommit} ${sourceCommit}`]: sourceCommit
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /must be reachable from remote main/
  )
})

test('rejects release commits with the wrong subject or payload', () => {
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        [`log -1 --format=%s ${releaseCommit}`]: 'chore: manual tag'
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /Unexpected release commit subject/
  )
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        [`diff-tree --no-commit-id --name-only -r ${releaseCommit}`]:
          'package.json\nREADME.md'
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /must change only package.json/
  )
})
