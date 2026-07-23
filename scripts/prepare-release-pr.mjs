import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildChangelogEntry,
  collectIgnoredCommits
} from './derive-bump-from-commits.mjs'
import {
  collectCommitMessages,
  deriveAutomaticVersion
} from './set-release-version.mjs'
import { parseReleaseVersion } from './release-version-utils.mjs'
import { parseChangelog } from './sync-release-notes-from-changelog.mjs'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = path.join(rootDir, 'package.json')
const changelogPath = path.join(rootDir, 'CHANGELOG.md')

function readGit(args) {
  return execFileSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8'
  }).trim()
}

export function findLatestStableTag({
  runGit = readGit
} = {}) {
  return runGit([
    'tag',
    '--merged',
    'HEAD',
    '--list',
    'v*',
    '--sort=-version:refname'
  ])
    .split(/\r?\n/u)
    .map(tag => tag.trim())
    .find(tag => /^v\d+\.\d+\.\d+$/u.test(tag)) ?? ''
}

export function insertChangelogEntry(changelog, entry, version) {
  const source = String(changelog)
  const entries = parseChangelog(source)
  if (entries[0].version === version) {
    return source
  }
  if (entries.some(candidate => candidate.version === version)) {
    throw new Error(
      `CHANGELOG.md already contains ${version} below a newer release`
    )
  }

  const lines = source.split(/\r?\n/u)
  const insertionIndex = entries[0].index
  const prefix = lines.slice(0, insertionIndex).join('\n').trimEnd()
  const suffix = lines.slice(insertionIndex).join('\n').trimStart()
  return `${prefix}\n\n${String(entry).trim()}\n\n${suffix}\n`
}

export function createReleasePlan({
  baselineTag,
  changelog,
  currentManifest,
  date,
  messages
}) {
  const currentVersion = parseReleaseVersion(
    currentManifest.version
  ).version
  const derived = deriveAutomaticVersion({
    baselineTag,
    currentVersion,
    messages
  })
  if (derived.version === null) {
    return {
      ignoredCommits: collectIgnoredCommits(messages),
      status: 'skipped'
    }
  }

  const entry = buildChangelogEntry({
    date,
    messages,
    version: derived.version
  })
  if (!entry) {
    throw new Error(
      `Cannot build CHANGELOG.md entry for release ${derived.version}`
    )
  }
  const nextChangelog = insertChangelogEntry(
    changelog,
    entry,
    derived.version
  )
  const nextManifest = {
    ...currentManifest,
    version: derived.version
  }
  return {
    bump: derived.bump,
    changelog: nextChangelog,
    changedFiles: [
      ...(nextChangelog === changelog ? [] : ['CHANGELOG.md']),
      'package.json'
    ],
    ignoredCommits: collectIgnoredCommits(messages),
    manifest: nextManifest,
    status: 'prepared',
    tag: `v${derived.version}`,
    version: derived.version
  }
}

export function prepareReleaseWorkingTree({
  getBaselineTag = findLatestStableTag,
  getMessages = collectCommitMessages,
  readChangelog = () => readFileSync(changelogPath, 'utf8'),
  readManifest = () => JSON.parse(readFileSync(packagePath, 'utf8')),
  runGit = readGit,
  sourceSha,
  writeChangelog = value => writeFileSync(changelogPath, value),
  writeManifest = value =>
    writeFileSync(packagePath, `${JSON.stringify(value, null, 2)}\n`)
}) {
  if (!/^[0-9a-f]{40,64}$/iu.test(sourceSha)) {
    throw new Error(`Invalid release source SHA: ${sourceSha}`)
  }
  const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head !== sourceSha) {
    throw new Error(
      `Release checkout ${head} does not match CI source ${sourceSha}`
    )
  }
  const date = runGit(['show', '-s', '--format=%cs', sourceSha])
  const baselineTag = getBaselineTag({ runGit })
  const messages = getMessages({ baselineTag, runGit })
  const plan = createReleasePlan({
    baselineTag,
    changelog: readChangelog(),
    currentManifest: readManifest(),
    date,
    messages
  })
  if (plan.status === 'skipped') {
    return { ...plan, baselineTag, date, messages }
  }

  writeManifest(plan.manifest)
  writeChangelog(plan.changelog)
  return { ...plan, baselineTag, date, messages }
}
