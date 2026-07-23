const conventionalSubjectPattern =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s+(?<description>.+)$/
const breakingFooterPattern = /^BREAKING[ -]CHANGE\s*:/
const mergeSubjectPattern =
  /^Merge (pull request|branch|remote-tracking branch)/
const releaseSubjectPattern = /^chore\(release\):/
const gitRevertSubjectPattern = /^Revert\s+"(?<reverted>.+)"$/

const changelogSectionByType = new Map([
  ['feat', 'Added'],
  ['perf', 'Changed'],
  ['fix', 'Fixed'],
  ['revert', 'Fixed']
])
const changelogSectionOrder = ['Added', 'Changed', 'Fixed']
const recognizedNonReleaseTypes = new Set([
  'docs',
  'chore',
  'refactor',
  'style',
  'test',
  'build',
  'ci'
])
const dependencyScopes = new Set(['deps', 'deps-dev'])

function isDependencyUpdate(commit) {
  return (
    (commit.type === 'build' || commit.type === 'chore') &&
    dependencyScopes.has(commit.scope)
  )
}

function getBreakingFooterText(body) {
  if (body.length === 0) {
    return null
  }
  const lines = body.split(/\r?\n/)
  let footerStart = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === '') {
      footerStart = index + 1
      break
    }
  }
  const footerLines = lines.slice(footerStart)
  const markerIndex = footerLines.findIndex(line =>
    breakingFooterPattern.test(line)
  )
  if (markerIndex === -1) {
    return null
  }
  return [
    footerLines[markerIndex].replace(breakingFooterPattern, ''),
    ...footerLines.slice(markerIndex + 1)
  ]
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
}

export function cancelRevertedPairs(messages) {
  const entries = messages.map(message => {
    const [rawSubject = ''] = String(message).split(/\r?\n/)
    return { message, subject: rawSubject.trim(), cancelled: false }
  })
  const pendingReverts = new Map()

  for (const [index, entry] of entries.entries()) {
    const waiting = pendingReverts.get(entry.subject)
    if (waiting?.length) {
      entries[waiting.shift()].cancelled = true
      entry.cancelled = true
      continue
    }
    const match = entry.subject.match(gitRevertSubjectPattern)
    if (match?.groups) {
      const stack = pendingReverts.get(match.groups.reverted) ?? []
      stack.push(index)
      pendingReverts.set(match.groups.reverted, stack)
    }
  }

  return entries.filter(entry => !entry.cancelled).map(entry => entry.message)
}

export function classifyCommit(message) {
  const [rawSubject = '', ...bodyLines] = String(message).split(/\r?\n/)
  const subject = rawSubject.trim()
  const breakingFooterText = getBreakingFooterText(bodyLines.join('\n'))
  const match = subject.match(conventionalSubjectPattern)

  if (!match?.groups) {
    const revertMatch = subject.match(gitRevertSubjectPattern)
    if (revertMatch?.groups) {
      return {
        type: 'revert',
        scope: null,
        breaking: breakingFooterText !== null,
        breakingDescription: breakingFooterText || null,
        description: `Revert "${revertMatch.groups.reverted}"`,
        isMerge: false,
        isReleaseCommit: false
      }
    }
    return {
      type: null,
      scope: null,
      breaking: breakingFooterText !== null,
      breakingDescription: breakingFooterText || null,
      description: subject,
      isMerge: mergeSubjectPattern.test(subject),
      isReleaseCommit: false
    }
  }

  return {
    type: match.groups.type,
    scope: match.groups.scope?.trim() || null,
    breaking: match.groups.breaking === '!' || breakingFooterText !== null,
    breakingDescription: breakingFooterText || null,
    description: match.groups.description.trim(),
    isMerge: false,
    isReleaseCommit: releaseSubjectPattern.test(subject)
  }
}

function selectReleaseWorthyCommits(messages) {
  return cancelRevertedPairs(messages)
    .map(classifyCommit)
    .filter(commit => !commit.isMerge && !commit.isReleaseCommit)
    .filter(
      commit =>
        commit.breaking ||
        isDependencyUpdate(commit) ||
        (commit.type !== null && changelogSectionByType.has(commit.type))
    )
}

export function collectIgnoredCommits(messages) {
  const ignored = []
  for (const message of cancelRevertedPairs(messages)) {
    const commit = classifyCommit(message)
    if (
      commit.isMerge ||
      commit.isReleaseCommit ||
      commit.breaking ||
      isDependencyUpdate(commit) ||
      changelogSectionByType.has(commit.type) ||
      recognizedNonReleaseTypes.has(commit.type)
    ) {
      continue
    }
    ignored.push(String(message).split(/\r?\n/, 1)[0].trim())
  }
  return ignored
}

export function deriveBumpFromCommits(messages) {
  let bump = null
  for (const commit of selectReleaseWorthyCommits(messages)) {
    if (commit.breaking) {
      return 'major'
    }
    if (commit.type === 'feat') {
      bump = 'minor'
    } else if (bump === null) {
      bump = 'patch'
    }
  }
  return bump
}

function capitalize(text) {
  return text ? text[0].toUpperCase() + text.slice(1) : text
}

export function buildChangelogEntry({ version, date, messages }) {
  const sections = new Map(changelogSectionOrder.map(name => [name, []]))

  for (const commit of selectReleaseWorthyCommits(messages)) {
    const section = isDependencyUpdate(commit)
      ? 'Fixed'
      : (changelogSectionByType.get(commit.type) ?? 'Changed')
    let prefix = ''
    if (commit.breaking) {
      prefix = commit.scope
        ? `**Breaking (${commit.scope}):** `
        : '**Breaking:** '
    } else if (commit.scope) {
      prefix = `**${commit.scope}:** `
    }
    const lines = [`- ${prefix}${capitalize(commit.description)}`]
    if (commit.breakingDescription) {
      lines.push(
        ...commit.breakingDescription.split('\n').map(line => `  ${line}`)
      )
    }
    sections.get(section).push(lines.join('\n'))
  }

  const parts = [`## ${version} - ${date}`]
  for (const section of changelogSectionOrder) {
    const bullets = sections.get(section)
    if (bullets.length > 0) {
      parts.push('', `### ${section}`, ...bullets)
    }
  }
  return parts.length > 1 ? `${parts.join('\n')}\n` : null
}
