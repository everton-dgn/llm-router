import { execFileSync as nodeExecFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertReleaseDate,
  normalizeReleaseTag,
  parseReleaseVersion
} from './release-version-utils.mjs'

const headingPattern =
  /^##\s+(\S+)\s+-\s+(\S+)\s*$/

export function parseChangelog(changelogText) {
  const lines = String(changelogText).split(/\r?\n/)
  const headings = []
  for (const [index, line] of lines.entries()) {
    const match = line.match(headingPattern)
    if (match) {
      const version = parseReleaseVersion(match[1]).version
      const date = assertReleaseDate(match[2])
      headings.push({ date, index, version })
    } else if (/^##\s+\d/u.test(line)) {
      throw new Error(
        `Invalid CHANGELOG.md release heading on line ${index + 1}`
      )
    }
  }
  if (headings.length === 0) {
    throw new Error(
      'CHANGELOG.md needs at least one heading formatted as ## X.Y.Z - YYYY-MM-DD'
    )
  }

  const versions = new Set()
  return headings.map((heading, index) => {
    if (versions.has(heading.version)) {
      throw new Error(
        `CHANGELOG.md contains duplicate release ${heading.version}`
      )
    }
    versions.add(heading.version)
    const end = headings[index + 1]?.index ?? lines.length
    const body = lines.slice(heading.index + 1, end)
    while (body[0]?.trim() === '') body.shift()
    while (body.at(-1)?.trim() === '') body.pop()
    if (body.length === 0) {
      throw new Error(
        `CHANGELOG.md release ${heading.version} must contain release notes`
      )
    }
    return {
      ...heading,
      notes: [
        `## ${heading.version} - ${heading.date}`,
        ...(body.length > 0 ? ['', ...body] : [])
      ].join('\n'),
      tag: `v${heading.version}`
    }
  })
}

function parseArgs(argv) {
  const result = {
    createIfMissing: false,
    expectedCommit: '',
    repo: process.env.GITHUB_REPOSITORY ?? '',
    tag: ''
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--expected-commit' || arg === '--repo' || arg === '--tag') {
      const key = arg === '--expected-commit' ? 'expectedCommit' : arg.slice(2)
      result[key] = argv[index + 1] ?? ''
      index += 1
    } else if (arg === '--create-if-missing') {
      result.createIfMissing = true
    } else {
      throw new Error(
        'Usage: node scripts/sync-release-notes-from-changelog.mjs --repo owner/repo --expected-commit SHA [--tag vX.Y.Z] [--create-if-missing]'
      )
    }
  }
  if (!result.repo) {
    throw new Error('Pass --repo or set GITHUB_REPOSITORY')
  }
  if (!/^[0-9a-f]{40,64}$/iu.test(result.expectedCommit)) {
    throw new Error('Pass --expected-commit with the verified release commit')
  }
  return result
}

function getRelease(tag, repo, execFileSync) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], {
        encoding: 'utf8'
      })
    )
  } catch (error) {
    const details = [
      error instanceof Error ? error.message : String(error),
      typeof error?.stderr === 'string'
        ? error.stderr
        : error?.stderr?.toString?.() ?? ''
    ].join('\n')
    if (/\bHTTP\s+404\b/iu.test(details)) return null
    throw error
  }
}

function updateRelease(releaseId, entry, repo, execFileSync) {
  execFileSync(
    'gh',
    [
      'api',
      '-X',
      'PATCH',
      `repos/${repo}/releases/${releaseId}`,
      '-f',
      `body=${entry.notes}`
    ],
    { stdio: 'inherit' }
  )
}

function assertRemoteTagCommit(tag, expectedCommit, execFileSync) {
  const output = execFileSync(
    'git',
    [
      'ls-remote',
      '--exit-code',
      'origin',
      `refs/tags/${tag}^{}`
    ],
    { encoding: 'utf8' }
  )
  const actualCommit = String(output).trim().split(/\s+/u)[0]
  if (actualCommit !== expectedCommit) {
    throw new Error(
      `Remote tag ${tag} moved from verified commit ${expectedCommit} to ${actualCommit || 'an unknown commit'}`
    )
  }
}

export function syncReleaseNotes(
  argv = process.argv.slice(2),
  { execFileSync = nodeExecFileSync, changelog } = {}
) {
  const args = parseArgs(argv)
  const source =
    changelog ??
    readFileSync(path.resolve(process.cwd(), 'CHANGELOG.md'), 'utf8')
  const entries = parseChangelog(source)
  const tag = args.tag ? normalizeReleaseTag(args.tag) : entries[0].tag
  const entry = entries.find(candidate => candidate.tag === tag)
  if (!entry) {
    throw new Error(`CHANGELOG.md has no entry for ${tag}`)
  }

  const release = getRelease(tag, args.repo, execFileSync)
  if (release) {
    assertRemoteTagCommit(tag, args.expectedCommit, execFileSync)
    updateRelease(release.id, entry, args.repo, execFileSync)
    console.log(`Updated release notes for ${tag}.`)
    return { action: 'updated', tag }
  }

  if (!args.createIfMissing) {
    console.log(`Release ${tag} does not exist; nothing changed.`)
    return { action: 'skipped', tag }
  }

  try {
    assertRemoteTagCommit(tag, args.expectedCommit, execFileSync)
    execFileSync(
      'gh',
      [
        'release',
        'create',
        tag,
        '--repo',
        args.repo,
        '--title',
        `llm-router ${tag}`,
        '--notes',
        entry.notes,
        '--verify-tag'
      ],
      { stdio: 'inherit' }
    )
  } catch (error) {
    const concurrentRelease = getRelease(tag, args.repo, execFileSync)
    if (!concurrentRelease) {
      throw error
    }
    assertRemoteTagCommit(tag, args.expectedCommit, execFileSync)
    updateRelease(concurrentRelease.id, entry, args.repo, execFileSync)
    console.log(`Updated concurrently created release ${tag}.`)
    return { action: 'updated-after-race', tag }
  }
  console.log(`Created release ${tag} from CHANGELOG.md.`)
  return { action: 'created', tag }
}

const isMainModule = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false

if (isMainModule) {
  syncReleaseNotes()
}
