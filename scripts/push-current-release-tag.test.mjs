import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertReleasePayload,
  createReleasePushArguments,
  getRemoteTagState,
  pushCurrentReleaseTag
} from './push-current-release-tag.mjs'

test('creates one atomic push with branch and tag leases', () => {
  const remoteMain = 'a'.repeat(40)
  assert.deepEqual(
    createReleasePushArguments('v0.1.0', remoteMain),
    [
      'push',
      '--atomic',
      `--force-with-lease=refs/heads/main:${remoteMain}`,
      '--force-with-lease=refs/tags/v0.1.0:',
      'origin',
      'HEAD:main',
      'refs/tags/v0.1.0'
    ]
  )
})

test('reads annotated and missing remote tags', () => {
  const objectId = 'b'.repeat(40)
  const commit = 'c'.repeat(40)
  let call = 0
  assert.deepEqual(
    getRemoteTagState('v0.1.0', () => {
      call += 1
      return call === 1
        ? `${objectId}\trefs/tags/v0.1.0`
        : `${commit}\trefs/tags/v0.1.0^{}`
    }),
    { commit, objectId }
  )
  assert.deepEqual(
    getRemoteTagState('v0.1.0', () => {
      throw new Error('missing')
    }),
    { commit: '', objectId: '' }
  )
})

test('accepts only a version-only release commit with matching notes', () => {
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
    /only the package.json version field/
  )
  assert.throws(
    () =>
      assertReleasePayload({
        changelog,
        currentManifest: { ...currentManifest, version: '0.2.0' },
        previousManifest
      }),
    /CHANGELOG.md/
  )
})

test('rechecks source CI before the guarded atomic push', () => {
  const source = 'a'.repeat(40)
  const release = 'b'.repeat(40)
  const writes = []
  let verifiedHead = ''
  pushCurrentReleaseTag({
    assertCi: ({ head }) => {
      verifiedHead = head
      return { repository: 'owner/repo', runId: 77 }
    },
    assertPushReady: () => ({
      advertisedMain: source,
      head: release
    }),
    getChangelog: () =>
      '# Changelog\n\n## 0.1.1 - 2026-07-23\n\n- Fix.\n',
    getCurrentManifest: () => ({
      name: 'llm-router',
      version: '0.1.1'
    }),
    readGit: args => {
      if (args.join(' ') === 'show HEAD^:package.json') {
        return JSON.stringify({
          name: 'llm-router',
          version: '0.1.0'
        })
      }
      if (args.join(' ') === 'rev-list -n 1 v0.1.1') return release
      if (args[0] === 'ls-remote') throw new Error('missing')
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    },
    writeGit: args => writes.push(args)
  })
  assert.equal(verifiedHead, source)
  assert.equal(writes.at(-1)[0], 'push')
})
