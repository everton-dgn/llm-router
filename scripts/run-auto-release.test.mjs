import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseAutomaticVersionOutput,
  readLatestChangelogVersion,
  resolveReleaseMode,
  runAutoRelease
} from './run-auto-release.mjs'

test('parses only machine-readable version output', () => {
  assert.equal(parseAutomaticVersionOutput('0.1.0\n'), '0.1.0')
  assert.equal(parseAutomaticVersionOutput('none\n'), 'none')
  assert.throws(
    () => parseAutomaticVersionOutput('next: 0.1.0'),
    /Unexpected/
  )
  assert.throws(() => parseAutomaticVersionOutput('01.2.3'), /Unexpected/)
})

test('reads the latest strict changelog heading', () => {
  assert.equal(
    readLatestChangelogVersion(
      '# Changelog\n\n## 0.2.0 - 2026-07-23\n\n- Current.\n\n## 0.1.0 - 2026-07-01\n\n- Previous.\n'
    ),
    '0.2.0'
  )
})

test('maps a version to exactly one SemVer bump', () => {
  assert.equal(resolveReleaseMode('0.0.0', '0.1.0'), 'minor')
  assert.throws(() => resolveReleaseMode('0.1.0', '0.3.0'), /Cannot map/)
})

test('skips before the full gate when no release is needed', () => {
  const calls = []
  assert.deepEqual(
    runAutoRelease({
      getNextVersion: () => 'none',
      runPnpm: args => calls.push(args),
      writeOutput: () => {}
    }),
    { status: 'skipped' }
  )
  assert.deepEqual(calls, [['release:preflight']])
})

test('runs gate, version commit and atomic push in order', () => {
  const calls = []
  const heads = ['source', 'release']
  assert.deepEqual(
    runAutoRelease({
      getChangelog: () =>
        '# Changelog\n\n## 0.1.0 - 2026-07-23\n\n- Initial release.\n',
      getCurrentVersion: () => '0.0.0',
      getHeadCommit: () => heads.shift(),
      getNextVersion: () => '0.1.0',
      assertCi: ({ head }) => {
        calls.push(['remote-ci', head])
        return { repository: 'owner/repo', runId: 42 }
      },
      runPnpm: args => calls.push(args),
      setVersion: mode => calls.push(['set-version', mode]),
      writeOutput: () => {}
    }),
    { mode: 'minor', status: 'released', version: '0.1.0' }
  )
  assert.deepEqual(calls, [
    ['release:preflight'],
    ['release:check'],
    ['remote-ci', 'source'],
    ['set-version', 'minor'],
    ['release:push']
  ])
})

test('rejects a changelog prepared for another version', () => {
  assert.throws(
    () =>
      runAutoRelease({
        getChangelog: () =>
          '# Changelog\n\n## 0.1.1 - 2026-07-23\n\n- Wrong release.\n',
        getCurrentVersion: () => '0.0.0',
        getNextVersion: () => '0.1.0',
        runPnpm: () => {},
        writeOutput: () => {}
      }),
    /Expected the latest CHANGELOG/
  )
})
