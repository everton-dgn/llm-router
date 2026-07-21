import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SCAN_BYTES = 100 * 1024 * 1024
const MAX_OUTPUT_CHARS = 100_000
const SENSITIVE_SUFFIXES = new Set([".pem", ".key", ".p12", ".pfx", ".crt"])
const SENSITIVE_NAMES = new Set([
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
])

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

export function isSensitiveRepositoryPath(value) {
  const normalized = String(value).replaceAll("\\", "/").toLowerCase()
  const parts = normalized.split("/").filter(Boolean)
  const name = parts.at(-1) ?? ""
  if (parts.includes(".git") || name === ".env" || name.startsWith(".env.")) return true
  if (SENSITIVE_SUFFIXES.has(path.extname(name)) || SENSITIVE_NAMES.has(name)) return true
  if (name.startsWith("service_account") && name.endsWith(".json")) return true
  const tail = parts.slice(-2).join("/")
  return tail === ".ssh/config" || tail === ".aws/credentials" || tail === ".kube/config"
}

function normalizeRelativePath(value = "") {
  const normalized = String(value).replaceAll("\\", "/").replace(/^\.\//, "")
  if (normalized === ".") return ""
  if (normalized.includes("\0") || path.posix.isAbsolute(normalized)) {
    throw new Error("repository path must be relative")
  }
  if (normalized.split("/").includes("..")) {
    throw new Error("repository path must stay inside the worktree")
  }
  return normalized.replace(/\/$/, "")
}

function filterByPath(files, requestedPath) {
  const filter = normalizeRelativePath(requestedPath)
  if (!filter) return files
  return files.filter((file) => file === filter || file.startsWith(`${filter}/`))
}

function parseNullList(stdout) {
  return stdout.split("\0").filter(Boolean)
}

async function runGit(worktree, argv, options = {}) {
  const { stdout } = await execFileAsync("git", argv, {
    cwd: worktree,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    ...options,
  })
  return stdout
}

async function repositoryFileNames(worktree, includeUntracked = false) {
  const argv = ["ls-files", "-z", "--cached"]
  if (includeUntracked) argv.push("--others", "--exclude-standard")
  const stdout = await runGit(worktree, argv)
  const all = parseNullList(stdout)
  return {
    count: all.length,
    files: all.filter((file) => !isSensitiveRepositoryPath(file)).sort(),
  }
}

async function safeRepositoryFiles(worktree, includeUntracked = false) {
  const { files: candidates } = await repositoryFileNames(worktree, includeUntracked)
  const safe = []
  for (const relative of candidates) {
    const candidate = path.resolve(worktree, relative)
    if (!isWithin(worktree, candidate)) continue
    try {
      const resolved = await realpath(candidate)
      const resolvedRelative = path.relative(worktree, resolved)
      if (isWithin(worktree, resolved) && !isSensitiveRepositoryPath(resolvedRelative)) {
        safe.push(relative)
      }
    } catch {
      continue
    }
  }
  return safe.sort()
}

async function readSafeText(worktree, relative) {
  const data = await readFile(path.resolve(worktree, relative))
  if (data.byteLength > MAX_FILE_BYTES) {
    throw new Error(`file exceeds the ${MAX_FILE_BYTES} byte inspection limit: ${relative}`)
  }
  if (data.includes(0)) throw new Error(`binary file cannot be inspected: ${relative}`)
  return data.toString("utf8")
}

function boundedMaxResults(value, fallback = 50) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("max_results must be an integer between 1 and 200")
  }
  return value
}

async function repositoryStatus(worktree) {
  const [branch, head, staged, unstaged, untracked] = await Promise.all([
    runGit(worktree, ["branch", "--show-current"]),
    runGit(worktree, ["rev-parse", "HEAD"]),
    runGit(worktree, ["diff", "--cached", "--name-only", "-z"]),
    runGit(worktree, ["diff", "--name-only", "-z"]),
    runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ])
  const safeNames = (output) => parseNullList(output).filter((file) => !isSensitiveRepositoryPath(file))
  return {
    action: "status",
    branch: branch.trim(),
    head: head.trim(),
    staged: safeNames(staged),
    unstaged: safeNames(unstaged),
    untracked: safeNames(untracked),
  }
}

async function listFiles(worktree, args) {
  const repositoryFiles = await repositoryFileNames(worktree, args.include_untracked === true)
  const files = filterByPath(repositoryFiles.files, args.path)
  const maxResults = boundedMaxResults(args.max_results, 100)
  return {
    action: "files",
    count: args.path ? files.length : repositoryFiles.count,
    visible_count: files.length,
    excluded_count: args.path ? 0 : repositoryFiles.count - repositoryFiles.files.length,
    files: files.slice(0, maxResults),
    truncated: files.length > maxResults,
  }
}

async function readRepositoryFile(worktree, args) {
  const requested = normalizeRelativePath(args.path)
  if (!requested) throw new Error("read_file requires a relative file path")
  const files = await safeRepositoryFiles(worktree, args.include_untracked === true)
  if (!files.includes(requested)) throw new Error("file is unavailable, ignored, external, or sensitive")
  const content = await readSafeText(worktree, requested)
  const lines = content.split("\n")
  const lineStart = args.line_start ?? 1
  const lineEnd = args.line_end ?? Math.min(lines.length, lineStart + 399)
  if (!Number.isInteger(lineStart) || lineStart < 1) throw new Error("line_start must be a positive integer")
  if (!Number.isInteger(lineEnd) || lineEnd < lineStart || lineEnd - lineStart >= 400) {
    throw new Error("line_end must be at least line_start and span at most 400 lines")
  }
  return {
    action: "read_file",
    path: requested,
    line_start: lineStart,
    line_end: Math.min(lineEnd, lines.length),
    lines: lines.slice(lineStart - 1, lineEnd).map((text, index) => ({
      number: lineStart + index,
      text,
    })),
  }
}

async function searchRepository(worktree, args) {
  if (typeof args.query !== "string" || args.query.length === 0 || args.query.length > 500) {
    throw new Error("search query must contain between 1 and 500 characters")
  }
  const maxResults = boundedMaxResults(args.max_results)
  const needle = args.case_sensitive === false ? args.query.toLocaleLowerCase() : args.query
  const files = filterByPath(await safeRepositoryFiles(worktree, args.include_untracked === true), args.path)
  const matches = []
  let scannedFiles = 0
  let skippedFiles = 0
  for (const relative of files) {
    let content
    try {
      content = await readSafeText(worktree, relative)
    } catch {
      skippedFiles += 1
      continue
    }
    scannedFiles += 1
    for (const [index, line] of content.split("\n").entries()) {
      const candidate = args.case_sensitive === false ? line.toLocaleLowerCase() : line
      if (!candidate.includes(needle)) continue
      matches.push({ path: relative, line: index + 1, text: line.slice(0, 2_000) })
      if (matches.length >= maxResults) {
        return { action: "search", query: args.query, matches, scanned_files: scannedFiles, skipped_files: skippedFiles, truncated: true }
      }
    }
  }
  return { action: "search", query: args.query, matches, scanned_files: scannedFiles, skipped_files: skippedFiles, truncated: false }
}

async function largestFilesByLines(worktree, args) {
  const maxResults = boundedMaxResults(args.max_results, 15)
  const files = filterByPath(await safeRepositoryFiles(worktree, args.include_untracked === true), args.path)
  const counted = []
  let scannedBytes = 0
  let skippedFiles = 0
  for (const relative of files) {
    let content
    try {
      content = await readSafeText(worktree, relative)
    } catch {
      skippedFiles += 1
      continue
    }
    scannedBytes += Buffer.byteLength(content)
    if (scannedBytes > MAX_SCAN_BYTES) {
      skippedFiles += files.length - counted.length
      break
    }
    counted.push({
      path: relative,
      lines: content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
    })
  }
  counted.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path))
  return {
    action: "largest_files_by_lines",
    files: counted.slice(0, maxResults),
    scanned_files: counted.length,
    skipped_files: skippedFiles,
    truncated: counted.length > maxResults || skippedFiles > 0,
  }
}

async function repositoryDiff(worktree, args) {
  const includeUntracked = args.include_untracked === true
  const [trackedChanges, untrackedChanges] = await Promise.all([
    runGit(worktree, ["diff", "HEAD", "--name-only", "-z"]),
    includeUntracked
      ? runGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"])
      : Promise.resolve(""),
  ])
  const tracked = parseNullList(trackedChanges).filter((file) => !isSensitiveRepositoryPath(file))
  const safeWorkingFiles = includeUntracked ? new Set(await safeRepositoryFiles(worktree, true)) : new Set()
  const untracked = new Set(
    parseNullList(untrackedChanges).filter((file) => safeWorkingFiles.has(file)),
  )
  const candidates = filterByPath([...new Set([...tracked, ...untracked])], args.path).sort()
  const maxResults = boundedMaxResults(args.max_results, 50)
  const items = []
  let outputChars = 0
  for (const relative of candidates.slice(0, maxResults)) {
    let diff
    if (untracked.has(relative)) {
      try {
        diff = await readSafeText(worktree, relative)
      } catch (error) {
        diff = `[unavailable: ${error.message}]`
      }
    } else {
      diff = await runGit(worktree, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", relative])
    }
    const remaining = Math.max(0, MAX_OUTPUT_CHARS - outputChars)
    const limited = diff.slice(0, remaining)
    outputChars += limited.length
    items.push({ path: relative, untracked: untracked.has(relative), diff: limited })
    if (outputChars >= MAX_OUTPUT_CHARS) break
  }
  return {
    action: "diff",
    files: items,
    truncated: candidates.length > items.length || outputChars >= MAX_OUTPUT_CHARS,
  }
}

async function repositoryLog(worktree, args) {
  const maxResults = boundedMaxResults(args.max_results, 20)
  const output = await runGit(worktree, ["log", `--max-count=${maxResults}`, "--format=%H%x09%h%x09%an%x09%aI%x09%s"])
  return {
    action: "log",
    commits: output.trim() ? output.trimEnd().split("\n").map((line) => {
      const [hash, short_hash, author, date, ...subject] = line.split("\t")
      return { hash, short_hash, author, date, subject: subject.join("\t") }
    }) : [],
  }
}

export async function runRepositoryQuery(args, worktreeValue) {
  const worktree = await realpath(worktreeValue)
  await runGit(worktree, ["rev-parse", "--show-toplevel"])
  switch (args.action) {
    case "status": return repositoryStatus(worktree)
    case "files": return listFiles(worktree, args)
    case "read_file": return readRepositoryFile(worktree, args)
    case "search": return searchRepository(worktree, args)
    case "largest_files_by_lines": return largestFilesByLines(worktree, args)
    case "diff": return repositoryDiff(worktree, args)
    case "log": return repositoryLog(worktree, args)
    default: throw new Error(`unsupported repository query action: ${args.action}`)
  }
}
