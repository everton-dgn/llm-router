import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createReleasePlan,
  insertChangelogEntry,
  prepareReleaseWorkingTree
} from './prepare-release-pr.mjs'

const existingChangelog = [
  '# Changelog',
  '',
  'Project releases.',
  '',
  '## 0.1.0 - 2026-07-20',
  '',
  '### Added',
  '',
  '- Initial release.',
  ''
].join('\n')
const firstStableChangelog = existingChangelog.replace(
  '## 0.1.0',
  '## 1.0.0'
)

test('prepares package metadata and prepends deterministic release notes', () => {
  const plan = createReleasePlan({
    baselineTag: 'v0.1.0',
    changelog: existingChangelog,
    currentManifest: {
      name: 'llm-router',
      private: true,
      version: '0.1.0'
    },
    date: '2026-07-23',
    messages: ['fix(router): retain the selected model']
  })

  assert.equal(plan.status, 'prepared')
  assert.equal(plan.version, '0.1.1')
  assert.equal(plan.tag, 'v0.1.1')
  assert.deepEqual(plan.changedFiles, ['CHANGELOG.md', 'package.json'])
  assert.equal(plan.manifest.version, '0.1.1')
  assert.match(
    plan.changelog,
    /## 0\.1\.1 - 2026-07-23[\s\S]*\*\*router:\*\* Retain the selected model/
  )
  assert.ok(
    plan.changelog.indexOf('## 0.1.1') <
      plan.changelog.indexOf('## 0.1.0')
  )
})

test('preserves a manually prepared matching changelog entry', () => {
  const plan = createReleasePlan({
    baselineTag: '',
    changelog: firstStableChangelog,
    currentManifest: {
      name: 'llm-router',
      private: true,
      version: '0.0.0'
    },
    date: '2026-07-23',
    messages: ['feat: publish the router']
  })

  assert.equal(plan.version, '1.0.0')
  assert.equal(plan.changelog, firstStableChangelog)
  assert.deepEqual(plan.changedFiles, ['package.json'])
})

test('rejects inserting a duplicate version below a newer release', () => {
  const changelog = existingChangelog.replace(
    '## 0.1.0',
    '## 0.2.0'
  ) + '\n## 0.1.0 - 2026-07-19\n\n- Older release.\n'
  assert.throws(
    () =>
      insertChangelogEntry(
        changelog,
        '## 0.1.0 - 2026-07-23\n\n- Duplicate.\n',
        '0.1.0'
      ),
    /already contains 0\.1\.0 below a newer release/
  )
})

test('skips documentation-only histories without writing files', () => {
  const writes = []
  const plan = prepareReleaseWorkingTree({
    sourceSha: 'a'.repeat(40),
    getBaselineTag: () => 'v0.1.0',
    getMessages: () => ['docs: explain releases'],
    readChangelog: () => existingChangelog,
    readManifest: () => ({
      name: 'llm-router',
      private: true,
      version: '0.1.0'
    }),
    runGit: args => {
      if (args[0] === 'rev-parse') return 'a'.repeat(40)
      if (args[0] === 'show') return '2026-07-23'
      throw new Error(`Unexpected git call: ${args.join(' ')}`)
    },
    writeChangelog: value => writes.push(value),
    writeManifest: value => writes.push(value)
  })

  assert.equal(plan.status, 'skipped')
  assert.deepEqual(writes, [])
})
