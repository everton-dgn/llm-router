const numericIdentifier = String.raw`(?:0|[1-9]\d*)`
const versionPattern = new RegExp(
  `^(?<major>${numericIdentifier})\\.(?<minor>${numericIdentifier})\\.(?<patch>${numericIdentifier})$`
)
const tagPattern = new RegExp(
  `^v(?<version>${numericIdentifier}\\.${numericIdentifier}\\.${numericIdentifier})$`
)
const datePattern = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/

function assertInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${value}`)
  }
}

export function assertReleaseDate(value) {
  const date = String(value).trim()
  const match = date.match(datePattern)
  if (!match?.groups) {
    throw new Error(`Invalid release date "${value}". Expected YYYY-MM-DD.`)
  }
  const year = Number.parseInt(match.groups.year, 10)
  const month = Number.parseInt(match.groups.month, 10)
  const day = Number.parseInt(match.groups.day, 10)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid release date "${value}".`)
  }
  return date
}

export function parseReleaseVersion(version) {
  const trimmed = String(version).trim()
  const match = trimmed.match(versionPattern)
  if (!match?.groups) {
    throw new Error(
      `Unsupported release version "${version}". Expected SemVer like 0.1.0.`
    )
  }

  const parsed = {
    version: trimmed,
    major: Number.parseInt(match.groups.major, 10),
    minor: Number.parseInt(match.groups.minor, 10),
    patch: Number.parseInt(match.groups.patch, 10)
  }
  assertInteger(parsed.major, 'major version')
  assertInteger(parsed.minor, 'minor version')
  assertInteger(parsed.patch, 'patch version')
  return parsed
}

export function normalizeReleaseTag(rawTag) {
  const trimmed = String(rawTag).trim().replace(/^refs\/tags\//, '')
  const match = trimmed.match(tagPattern)
  if (!match?.groups?.version) {
    throw new Error(
      `Unsupported release tag "${rawTag}". Expected a stable vX.Y.Z tag.`
    )
  }
  return `v${match.groups.version}`
}

export function computeNextReleaseVersion(currentVersion, mode) {
  const current = parseReleaseVersion(currentVersion)
  if (mode === 'patch') {
    return `${current.major}.${current.minor}.${current.patch + 1}`
  }
  if (mode === 'minor') {
    return `${current.major}.${current.minor + 1}.0`
  }
  if (mode === 'major') {
    return `${current.major + 1}.0.0`
  }
  throw new Error(`Unsupported release mode "${mode}".`)
}

export function resolveAutoBump(bump, currentVersion) {
  if (bump === 'major' && parseReleaseVersion(currentVersion).major === 0) {
    return 'minor'
  }
  return bump
}
