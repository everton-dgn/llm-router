import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleaseDate,
  computeNextReleaseVersion,
  normalizeReleaseTag,
  parseReleaseVersion,
  resolveAutoBump
} from './release-version-utils.mjs'

test('parses stable SemVer and rejects prereleases', () => {
  assert.deepEqual(parseReleaseVersion('0.1.2'), {
    major: 0,
    minor: 1,
    patch: 2,
    version: '0.1.2'
  })
  assert.throws(() => parseReleaseVersion('0.1.2-beta.1'), /Unsupported/)
  assert.throws(() => parseReleaseVersion('01.2.3'), /Unsupported/)
  assert.throws(
    () => parseReleaseVersion('9007199254740992.0.0'),
    /Invalid major/
  )
})

test('computes each supported bump', () => {
  assert.equal(computeNextReleaseVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(computeNextReleaseVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(computeNextReleaseVersion('1.2.3', 'major'), '2.0.0')
})

test('keeps automatic breaking changes inside 0.x', () => {
  assert.equal(resolveAutoBump('major', '0.4.2'), 'minor')
  assert.equal(resolveAutoBump('major', '1.4.2'), 'major')
})

test('normalizes only stable release tags', () => {
  assert.equal(normalizeReleaseTag('refs/tags/v1.2.3'), 'v1.2.3')
  assert.throws(() => normalizeReleaseTag('v1.2.3-rc.1'), /Unsupported/)
  assert.throws(() => normalizeReleaseTag('v01.2.3'), /Unsupported/)
})

test('accepts only real ISO calendar dates', () => {
  assert.equal(assertReleaseDate('2026-07-23'), '2026-07-23')
  assert.throws(() => assertReleaseDate('2026-99-99'), /Invalid release date/)
  assert.throws(() => assertReleaseDate('2025-02-29'), /Invalid release date/)
})
