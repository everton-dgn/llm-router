import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChangelogEntry,
  cancelRevertedPairs,
  collectIgnoredCommits,
  deriveBumpFromCommits
} from './derive-bump-from-commits.mjs'

test('derives SemVer precedence from Conventional Commits', () => {
  assert.equal(deriveBumpFromCommits(['fix: correct route']), 'patch')
  assert.equal(
    deriveBumpFromCommits(['fix: correct route', 'feat: add provider']),
    'minor'
  )
  assert.equal(
    deriveBumpFromCommits(['feat!: change session metadata']),
    'major'
  )
  assert.equal(deriveBumpFromCommits(['docs: update guide']), null)
  assert.equal(
    deriveBumpFromCommits(['chore(deps): update locked dependency']),
    'patch'
  )
  assert.equal(
    deriveBumpFromCommits(['build(deps-dev): update test dependency']),
    'patch'
  )
})

test('recognizes a BREAKING CHANGE footer', () => {
  assert.equal(
    deriveBumpFromCommits([
      'refactor(router): replace contract\n\nBREAKING CHANGE: config schema changed'
    ]),
    'major'
  )
})

test('cancels a revert with its target commit', () => {
  assert.deepEqual(
    cancelRevertedPairs([
      'Revert "feat: add unsafe route"',
      'feat: add unsafe route',
      'fix: keep this'
    ]),
    ['fix: keep this']
  )
})

test('warns only about unrecognized commit subjects', () => {
  assert.deepEqual(
    collectIgnoredCommits([
      'docs: update guide',
      'faet: typo',
      'plain subject',
      'fix: valid'
    ]),
    ['faet: typo', 'plain subject']
  )
})

test('builds a Keep a Changelog compatible entry', () => {
  const entry = buildChangelogEntry({
    date: '2026-07-23',
    messages: ['feat(router): add adaptive mode', 'fix: retain context'],
    version: '0.1.0'
  })
  assert.match(entry, /^## 0\.1\.0 - 2026-07-23/)
  assert.match(entry, /### Added\n- \*\*router:\*\* Add adaptive mode/)
  assert.match(entry, /### Fixed\n- Retain context/)
})

test('places dependency updates in the Fixed section', () => {
  const entry = buildChangelogEntry({
    date: '2026-07-23',
    messages: ['chore(deps): update runtime dependency'],
    version: '0.1.1'
  })
  assert.match(
    entry,
    /### Fixed\n- \*\*deps:\*\* Update runtime dependency/
  )
})
