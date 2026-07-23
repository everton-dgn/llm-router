import { isDeepStrictEqual } from 'node:util'

import {
  computeNextReleaseVersion,
  parseReleaseVersion
} from './release-version-utils.mjs'
import { parseChangelog } from './sync-release-notes-from-changelog.mjs'

const allowedReleaseFiles = new Set(['CHANGELOG.md', 'package.json'])

export function assertReleaseChangedFiles(changedFiles) {
  const files = [...changedFiles]
  const uniqueFiles = new Set(files)
  if (
    files.length !== uniqueFiles.size ||
    !uniqueFiles.has('package.json') ||
    files.some(file => !allowedReleaseFiles.has(file))
  ) {
    throw new Error(
      `Release commit must change package.json and may also change CHANGELOG.md, received: ${files.join(', ') || 'no files'}`
    )
  }
  return files
}

export function assertReleasePayload({
  changelog,
  currentManifest,
  previousManifest
}) {
  const currentVersion = parseReleaseVersion(currentManifest.version).version
  const previousVersion = parseReleaseVersion(previousManifest.version).version
  const { version: _currentVersion, ...currentRest } = currentManifest
  const { version: _previousVersion, ...previousRest } = previousManifest
  if (!isDeepStrictEqual(currentRest, previousRest)) {
    throw new Error(
      'Release commit may change only the package.json version field'
    )
  }
  const isSingleBump = ['patch', 'minor', 'major'].some(
    mode =>
      computeNextReleaseVersion(previousVersion, mode) === currentVersion
  )
  if (!isSingleBump) {
    throw new Error(
      `Release version ${previousVersion} -> ${currentVersion} is not one supported SemVer bump`
    )
  }
  const changelogVersion = parseChangelog(changelog)[0].version
  if (changelogVersion !== currentVersion) {
    throw new Error(
      `Latest CHANGELOG.md release ${changelogVersion} does not match package.json ${currentVersion}`
    )
  }
  return currentVersion
}
