import assert from 'node:assert/strict'
import test from 'node:test'

import { verifyPublishedReleaseTag } from './verify-release-tag.mjs'

const releaseCommit = 'b'.repeat(40)
const sourceCommit = 'a'.repeat(40)
const baseCommit = 'c'.repeat(40)
const mergeCommit = 'd'.repeat(40)
const mainCommit = 'e'.repeat(40)
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
    ['rev-list -n 1 refs/tags/v0.2.0', mergeCommit],
    [
      'ls-remote --exit-code --heads origin refs/heads/main',
      `${mainCommit}\trefs/heads/main`
    ],
    [`merge-base ${mergeCommit} ${mainCommit}`, mergeCommit],
    [
      `rev-list --parents -n 1 ${mergeCommit}`,
      `${mergeCommit} ${baseCommit} ${releaseCommit}`
    ],
    [
      `rev-list --parents -n 1 ${releaseCommit}`,
      `${releaseCommit} ${sourceCommit}`
    ],
    [`merge-base ${sourceCommit} ${baseCommit}`, sourceCommit],
    [
      `log -1 --format=%s ${releaseCommit}`,
      'chore(release): cut v0.2.0'
    ],
    [
      `diff --name-only ${sourceCommit} ${releaseCommit}`,
      'CHANGELOG.md\npackage.json'
    ],
    [
      `diff --name-only ${baseCommit} ${mergeCommit}`,
      'CHANGELOG.md\npackage.json'
    ],
    [
      `show ${releaseCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.2.0' })
    ],
    [
      `show ${mergeCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.2.0' })
    ],
    [
      `show ${sourceCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.1.0' })
    ],
    [
      `show ${baseCommit}:package.json`,
      JSON.stringify({ name: 'llm-router', version: '0.1.0' })
    ],
    [`show ${releaseCommit}:CHANGELOG.md`, changelog],
    [`show ${mergeCommit}:CHANGELOG.md`, changelog]
  ])
  for (const [key, value] of Object.entries(overrides)) responses.set(key, value)
  return args => {
    const key = args.join(' ')
    if (!responses.has(key)) throw new Error(`Unexpected git call: ${key}`)
    return responses.get(key)
  }
}

test('accepts only the annotated release merge at remote main with base CI', () => {
  const ciHeads = []
  const result = verifyPublishedReleaseTag({
    tag: 'v0.2.0',
    runGit: releaseGit(),
    assertCi: ({ head }) => {
      ciHeads.push(head)
      return { repository: 'owner/repo', runId: 42 }
    }
  })

  assert.deepEqual(ciHeads, [baseCommit])
  assert.deepEqual(result, {
    parent: baseCommit,
    releaseHead: releaseCommit,
    repository: 'owner/repo',
    runId: 42,
    source: sourceCommit,
    tag: 'v0.2.0',
    tagCommit: mergeCommit
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
        [`merge-base ${mergeCommit} ${sourceCommit}`]: sourceCommit
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
        [`diff --name-only ${sourceCommit} ${releaseCommit}`]:
          'package.json\nREADME.md'
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /may also change CHANGELOG\.md/
  )
})

test('rejects merge tags with the wrong second parent or altered merge payload', () => {
  const unrelatedHead = 'f'.repeat(40)
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        [`rev-list --parents -n 1 ${mergeCommit}`]:
          `${mergeCommit} ${baseCommit} ${unrelatedHead}`,
        [`rev-list --parents -n 1 ${unrelatedHead}`]:
          `${unrelatedHead} ${sourceCommit}`,
        [`log -1 --format=%s ${unrelatedHead}`]: 'chore: unrelated'
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /Unexpected release commit subject/
  )
  assert.throws(
    () => verifyPublishedReleaseTag({
      tag: 'v0.2.0',
      runGit: releaseGit({
        [`show ${mergeCommit}:CHANGELOG.md`]:
          changelog.replace('Release notes.', 'Altered after validation.')
      }),
      assertCi: () => ({ repository: 'owner/repo', runId: 42 })
    }),
    /must match the validated release branch/
  )
})
