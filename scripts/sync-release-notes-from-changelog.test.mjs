import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  parseChangelog,
  syncReleaseNotes
} from './sync-release-notes-from-changelog.mjs'

const changelog = [
  '# Changelog',
  '',
  '## 0.2.0 - 2026-07-23',
  '',
  '### Added',
  '- Adaptive mode.',
  '',
  '## 0.1.0 - 2026-07-01',
  '',
  '- Initial release.',
  ''
].join('\n')
const expectedCommit = 'a'.repeat(40)
const verifiedArgs = [
  '--repo',
  'everton-dgn/llm-router',
  '--expected-commit',
  expectedCommit
]

function missingReleaseError() {
  const error = new Error('GitHub API returned HTTP 404')
  error.stderr = 'gh: Not Found (HTTP 404)'
  return error
}

test('parses release sections independently', () => {
  const entries = parseChangelog(changelog)
  assert.deepEqual(
    entries.map(entry => entry.tag),
    ['v0.2.0', 'v0.1.0']
  )
  assert.match(entries[0].notes, /Adaptive mode/)
  assert.doesNotMatch(entries[0].notes, /Initial release/)
})

test('rejects invalid dates, duplicate versions and empty releases', () => {
  assert.throws(
    () => parseChangelog('## 0.1.0 - 2026-99-99\n\n- Notes.\n'),
    /Invalid release date/
  )
  assert.throws(
    () =>
      parseChangelog(
        '## 0.1.0 - 2026-07-23\n\n- One.\n\n## 0.1.0 - 2026-07-22\n\n- Two.\n'
      ),
    /duplicate release/
  )
  assert.throws(
    () => parseChangelog('## 0.1.0 - 2026-07-23\n'),
    /must contain release notes/
  )
})

test('updates an existing GitHub Release by id', () => {
  const calls = []
  const result = syncReleaseNotes(
    [...verifiedArgs, '--tag', 'v0.2.0'],
    {
      changelog,
      execFileSync: (command, args) => {
        calls.push(args)
        if (command === 'git') {
          return `${expectedCommit}\trefs/tags/v0.2.0^{}`
        }
        if (args[0] === 'api' && args.length === 2) {
          return JSON.stringify({ id: 42 })
        }
        return ''
      }
    }
  )
  assert.deepEqual(result, { action: 'updated', tag: 'v0.2.0' })
  assert.equal(
    calls.some(args => args.includes('repos/everton-dgn/llm-router/releases/42')),
    true
  )
})

test('creates a missing release only with explicit opt-in', () => {
  const calls = []
  const result = syncReleaseNotes(
    [...verifiedArgs, '--create-if-missing'],
    {
      changelog,
      execFileSync: (command, args) => {
        calls.push(args)
        if (command === 'git') {
          return `${expectedCommit}\trefs/tags/v0.2.0^{}`
        }
        if (args[0] === 'api') throw missingReleaseError()
        return ''
      }
    }
  )
  assert.deepEqual(result, { action: 'created', tag: 'v0.2.0' })
  assert.equal(calls.some(args => args[0] === 'release'), true)
})

test('reads release notes from the verified commit instead of the checkout', () => {
  const calls = []
  const result = syncReleaseNotes(
    [...verifiedArgs, '--tag', 'v0.2.0'],
    {
      execFileSync: (command, args) => {
        calls.push([command, args])
        if (
          command === 'git' &&
          args[0] === 'show' &&
          args[1] === `${expectedCommit}:CHANGELOG.md`
        ) {
          return changelog
        }
        if (command === 'git') {
          return `${expectedCommit}\trefs/tags/v0.2.0^{}`
        }
        if (args[0] === 'api' && args.length === 2) {
          return JSON.stringify({ id: 42 })
        }
        return ''
      }
    }
  )
  assert.deepEqual(result, { action: 'updated', tag: 'v0.2.0' })
  assert.equal(
    calls.some(([command, args]) =>
      command === 'git' &&
      args[0] === 'show' &&
      args[1] === `${expectedCommit}:CHANGELOG.md`
    ),
    true
  )
})

test('updates the release when another run creates it first', () => {
  const calls = []
  let getAttempts = 0
  const result = syncReleaseNotes(
    [...verifiedArgs, '--create-if-missing'],
    {
      changelog,
      execFileSync: (command, args) => {
        calls.push(args)
        if (command === 'git') {
          return `${expectedCommit}\trefs/tags/v0.2.0^{}`
        }
        if (args[0] === 'api' && args.length === 2) {
          getAttempts += 1
          if (getAttempts === 1) throw missingReleaseError()
          return JSON.stringify({ id: 84 })
        }
        if (args[0] === 'release') {
          throw new Error('already exists')
        }
        return ''
      }
    }
  )
  assert.deepEqual(result, {
    action: 'updated-after-race',
    tag: 'v0.2.0'
  })
  assert.equal(
    calls.some(args => args.includes('repos/everton-dgn/llm-router/releases/84')),
    true
  )
})

test('fails closed when the release lookup fails for a reason other than 404', () => {
  const calls = []
  assert.throws(
    () => syncReleaseNotes(
      [...verifiedArgs, '--create-if-missing'],
      {
        changelog,
        execFileSync: (_command, args) => {
          calls.push(args)
          throw new Error('GitHub authentication failed')
        }
      }
    ),
    /authentication failed/
  )
  assert.equal(calls.some(args => args[0] === 'release'), false)
  assert.throws(
    () => syncReleaseNotes(
      [...verifiedArgs, '--create-if-missing'],
      {
        changelog,
        execFileSync: () => {
          throw new Error('Upstream proxy returned Not Found without an HTTP status')
        }
      }
    ),
    /Not Found/
  )
})

test('fails closed when the remote tag moves after verification', () => {
  const calls = []
  assert.throws(
    () => syncReleaseNotes(
      [...verifiedArgs, '--tag', 'v0.2.0'],
      {
        changelog,
        execFileSync: (command, args) => {
          calls.push([command, args])
          if (command === 'git') {
            return `${'b'.repeat(40)}\trefs/tags/v0.2.0^{}`
          }
          if (args[0] === 'api' && args.length === 2) {
            return JSON.stringify({ id: 42 })
          }
          return ''
        }
      }
    ),
    /Remote tag v0\.2\.0 moved/
  )
  assert.equal(
    calls.some(([command, args]) =>
      command === 'gh' && args.includes('PATCH')
    ),
    false
  )
})

test('release notes sync workflow only runs on manual dispatch', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/release-notes-sync.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /^on:\n {2}workflow_dispatch:$/mu)
  assert.doesNotMatch(workflow, /^ {2}push:$/mu)
  assert.doesNotMatch(workflow, /github\.ref_name|github\.event_name/u)
  assert.match(workflow, /permissions:\n\s+actions: read\n\s+contents: write/u)
  assert.match(workflow, /--print-commit/u)
  for (const match of workflow.matchAll(/uses:\s+\S+@(\S+)/gu)) {
    assert.match(match[1], /^[0-9a-f]{40}$/u)
  }
})
