import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleaseChangedFiles,
  assertReleasePayload
} from './release-payload.mjs'

test('accepts the exact automatic release file set', () => {
  assert.deepEqual(
    assertReleaseChangedFiles(['CHANGELOG.md', 'package.json']),
    ['CHANGELOG.md', 'package.json']
  )
  assert.deepEqual(
    assertReleaseChangedFiles(['package.json']),
    ['package.json']
  )
  assert.throws(
    () => assertReleaseChangedFiles(['package.json', 'README.md']),
    /may also change CHANGELOG\.md/
  )
  assert.throws(
    () => assertReleaseChangedFiles(['CHANGELOG.md']),
    /must change package\.json/
  )
})

test('accepts one SemVer bump with matching release notes', () => {
  const previousManifest = {
    name: 'llm-router',
    private: true,
    version: '0.1.0'
  }
  const currentManifest = {
    name: 'llm-router',
    private: true,
    version: '0.1.1'
  }
  const changelog =
    '# Changelog\n\n## 0.1.1 - 2026-07-23\n\n- Fix release validation.\n'
  assert.equal(
    assertReleasePayload({
      changelog,
      currentManifest,
      previousManifest
    }),
    '0.1.1'
  )
  assert.throws(
    () =>
      assertReleasePayload({
        changelog,
        currentManifest: { ...currentManifest, private: false },
        previousManifest
      }),
    /only the package\.json version field/
  )
  assert.throws(
    () =>
      assertReleasePayload({
        changelog,
        currentManifest: { ...currentManifest, version: '0.2.0' },
        previousManifest
      }),
    /CHANGELOG\.md/
  )
})
