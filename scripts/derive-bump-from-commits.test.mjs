import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildChangelogEntry,
  cancelRevertedPairs,
  collectIgnoredCommits,
  deriveBumpFromCommits,
  sanitizeReleaseNoteText
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

test('neutralizes active Markdown, mentions, references, and HTML', () => {
  const entry = buildChangelogEntry({
    date: '2026-07-23',
    messages: [
      'feat(ui** @octocat <b>): add [trusted](https://evil.example) @team <img src=x> `safe()` www.evil.test #42'
    ],
    version: '0.2.0'
  })

  assert.equal(
    entry,
    [
      '## 0.2.0 - 2026-07-23',
      '',
      '### Added',
      '- **ui\\*\\* &#64;octocat &lt;b&gt;:** Add \\[trusted\\](`https://evil.example`) &#64;team &lt;img src=x&gt; `safe()` `www.evil.test` &#35;42',
      ''
    ].join('\n')
  )
})

test('applies the same sanitization to BREAKING CHANGE footer text', () => {
  const entry = buildChangelogEntry({
    date: '2026-07-23',
    messages: [
      'refactor(api): replace contract\n\nBREAKING CHANGE: read [guide](https://evil.example) @maintainers <script>alert(1)</script> and keep `client.call()`'
    ],
    version: '1.0.0'
  })

  assert.equal(
    entry,
    [
      '## 1.0.0 - 2026-07-23',
      '',
      '### Changed',
      '- **Breaking (api):** Replace contract',
      '  read \\[guide\\](`https://evil.example`) &#64;maintainers &lt;script&gt;alert(1)&lt;/script&gt; and keep `client.call()`',
      ''
    ].join('\n')
  )
  assert.doesNotMatch(entry, /\]\(https?:\/\//)
  assert.doesNotMatch(entry, /@maintainers|<script>/)
})

test('preserves valid backtick spans while sanitizing surrounding text', () => {
  assert.equal(
    sanitizeReleaseNoteText(
      'use ``a `nested` value`` with @owner and https://example.test'
    ),
    'use ``a `nested` value`` with &#64;owner and `https://example.test`'
  )
})

test('keeps ordinary prose readable and neutralizes unmatched backticks', () => {
  assert.equal(
    sanitizeReleaseNoteText(
      'fix route-parser: preserve foo/bar, version 1.2.3 and unmatched `code'
    ),
    'fix route-parser: preserve foo/bar, version 1.2.3 and unmatched &#96;code'
  )
  assert.equal(sanitizeReleaseNoteText('- nested item'), '\\- nested item')
  assert.equal(sanitizeReleaseNoteText('1. nested item'), '1\\. nested item')
  assert.equal(sanitizeReleaseNoteText('# fake heading'), '\\# fake heading')
  assert.equal(sanitizeReleaseNoteText('---'), '\\---')
  assert.equal(sanitizeReleaseNoteText('==='), '\\===')
})
