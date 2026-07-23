import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectCommitMessages,
  deriveAutomaticVersion,
  runReleaseVersionPreview
} from './set-release-version.mjs'

test('promotes the first release to the stable 1.0.0 line', () => {
  assert.deepEqual(
    deriveAutomaticVersion({
      baselineTag: '',
      currentVersion: '0.0.0',
      messages: ['feat: initial public router']
    }),
    { bump: 'major', version: '1.0.0' }
  )
})

test('requires package version to match the latest stable tag', () => {
  assert.throws(
    () =>
      deriveAutomaticVersion({
        baselineTag: 'v0.1.0',
        currentVersion: '0.1.1',
        messages: ['fix: route']
      }),
    /does not match latest tag/
  )
})

test('returns no version for documentation-only commits', () => {
  assert.deepEqual(
    deriveAutomaticVersion({
      baselineTag: 'v0.1.0',
      currentVersion: '0.1.0',
      messages: ['docs: update examples']
    }),
    { bump: null, version: null }
  )
})

test('collects commit bodies from the correct baseline range', () => {
  let invocation
  const messages = collectCommitMessages({
    baselineTag: 'v0.1.0',
    runGit: args => {
      invocation = args
      return 'fix: one\u0000feat: two\n\nbody\u0000'
    }
  })
  assert.deepEqual(messages, ['fix: one', 'feat: two\n\nbody'])
  assert.equal(invocation[1], 'v0.1.0..HEAD')
})

test('reports local and remote candidate tags as conflicts', () => {
  const dependencies = {
    getBaselineTag: () => '',
    getMessages: () => ['feat: initial public router']
  }
  assert.throws(
    () =>
      runReleaseVersionPreview(['--mode', 'auto', '--print'], {
        ...dependencies,
        hasLocalTag: () => true,
        hasRemoteTag: () => false
      }),
    /already exists locally/
  )
  assert.throws(
    () =>
      runReleaseVersionPreview(['--mode', 'auto', '--print'], {
        ...dependencies,
        hasLocalTag: () => false,
        hasRemoteTag: () => true
      }),
    /already exists on origin/
  )
})

test('allows only read-only automatic version discovery from the CLI', () => {
  assert.throws(
    () => runReleaseVersionPreview(['--mode', 'minor']),
    /--mode auto --print/
  )
})
