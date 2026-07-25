import assert from "node:assert/strict"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const ignoredDirectories = new Set([
  ".claude",
  ".git",
  ".idea",
  "logs",
  "node_modules",
  "plans",
])

async function collectMarkdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue
    }
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(target)))
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(target)
    }
  }

  return files
}

const fencePattern = /^((?:[ \t]*>)*)[ \t]{0,3}(`{3,}|~{3,})(.*)$/
const blockquotePrefixPattern = /^(?:[ \t]*>)*/

function blockquoteDepth(line) {
  return (blockquotePrefixPattern.exec(line)[0].match(/>/g) ?? []).length
}

function maskInlineCode(text) {
  let masked = ""
  let cursor = 0

  while (cursor < text.length) {
    const opening = text.indexOf("`", cursor)
    if (opening === -1) {
      masked += text.slice(cursor)
      break
    }
    masked += text.slice(cursor, opening)

    let runLength = 1
    while (text[opening + runLength] === "`") {
      runLength += 1
    }
    const delimiter = "`".repeat(runLength)

    let searchFrom = opening + runLength
    let closing = -1
    while (searchFrom < text.length) {
      const candidate = text.indexOf(delimiter, searchFrom)
      if (candidate === -1) {
        break
      }
      let candidateLength = runLength
      while (text[candidate + candidateLength] === "`") {
        candidateLength += 1
      }
      if (candidateLength === runLength) {
        closing = candidate
        break
      }
      searchFrom = candidate + candidateLength
    }

    if (closing === -1) {
      masked += text.slice(opening)
      break
    }
    masked += text
      .slice(opening, closing + runLength)
      .replace(/[^\n]/g, " ")
    cursor = closing + runLength
  }

  return masked
}

function stripCodeSpans(markdown) {
  const kept = []
  let fence = null

  for (const line of markdown.split("\n")) {
    const match = fencePattern.exec(line)

    if (fence) {
      // A fence opened inside a blockquote ends with that blockquote level.
      if (fence.depth > 0 && blockquoteDepth(line) < fence.depth) {
        fence = null
      } else {
        if (
          match &&
          match[2][0] === fence.delimiter[0] &&
          match[2].length >= fence.delimiter.length &&
          match[3].trim() === ""
        ) {
          fence = null
        }
        kept.push("")
        continue
      }
    }

    // A backtick fence cannot carry a backtick in its info string, so a line
    // such as ```lang` opens no block and must keep its links visible.
    if (match && !(match[2][0] === "`" && match[3].includes("`"))) {
      fence = { delimiter: match[2], depth: blockquoteDepth(match[1]) }
      kept.push("")
      continue
    }

    kept.push(line)
  }

  // A code span never crosses a blank line, so mask one paragraph at a time.
  return kept
    .join("\n")
    .split(/\n[ \t]*\n/)
    .map(maskInlineCode)
    .join("\n\n")
}

function localLinkTargets(markdown) {
  const targets = []
  const pattern = /!?\[[^\]]*]\(([^)]+)\)/g
  for (const match of stripCodeSpans(markdown).matchAll(pattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, "")
    const target = raw.split(/\s+(?=["'])/, 1)[0]
    if (
      target === "" ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      continue
    }
    targets.push(target)
  }
  return targets
}

function githubSlug(text) {
  return text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}

function markdownAnchors(markdown) {
  const anchors = new Set()
  const slugCounts = new Map()
  let insideFence = false

  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue

    for (const match of line.matchAll(
      /<a\s+(?:id|name)=["']([^"']+)["'][^>]*>/gi,
    )) {
      anchors.add(match[1])
    }

    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)
    if (!heading) continue
    const base = githubSlug(heading[1])
    const count = slugCounts.get(base) ?? 0
    slugCounts.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }

  return anchors
}

test("link detection ignores inline code and fenced blocks", () => {
  assert.deepEqual(localLinkTargets("read [guide](docs/RELEASE.md) now"), [
    "docs/RELEASE.md",
  ])
  assert.deepEqual(localLinkTargets("mention `[setup](docs/missing.md)` here"), [])
  assert.deepEqual(
    localLinkTargets("keep ``a `nested` [x](docs/missing.md)`` intact"),
    [],
  )
  assert.deepEqual(
    localLinkTargets(
      ["```md", "[sample](docs/missing.md)", "```", "[real](docs/README.md)"].join(
        "\n",
      ),
    ),
    ["docs/README.md"],
  )
  assert.deepEqual(localLinkTargets("unmatched ` [x](docs/missing.md)"), [
    "docs/missing.md",
  ])
  assert.deepEqual(
    localLinkTargets("escaped \\[setup guide\\]\\(docs/missing.md\\) stays inert"),
    [],
  )
})

test("link detection survives fences in containers and spans across lines", () => {
  // A backtick info string opens no fence, so later links stay visible.
  assert.deepEqual(
    localLinkTargets(["```lang`", "[real](docs/README.md)"].join("\n")),
    ["docs/README.md"],
  )
  // A closing delimiter must stand alone, so the block stays open here.
  assert.deepEqual(
    localLinkTargets(
      ["```", "``` js", "[sample](docs/missing.md)", "```"].join("\n"),
    ),
    [],
  )
  assert.deepEqual(
    localLinkTargets(
      ["- item:", "  ```md", "  [sample](docs/missing.md)", "  ```"].join("\n"),
    ),
    [],
  )
  assert.deepEqual(
    localLinkTargets(
      ["> ```md", "> [sample](docs/missing.md)", "> ```"].join("\n"),
    ),
    [],
  )
  assert.deepEqual(
    localLinkTargets(["spanning `code", "[sample](docs/missing.md)` tail"].join("\n")),
    [],
  )
  assert.deepEqual(
    localLinkTargets(
      ["spanning `code", "[sample](docs/missing.md)` tail", "[real](docs/README.md)"].join(
        "\n",
      ),
    ),
    ["docs/README.md"],
  )
})

test("link detection keeps quotes and paragraphs apart", () => {
  // A fence inside a blockquote ends with the blockquote itself.
  assert.deepEqual(
    localLinkTargets(
      ["> ```", "> literal code", "", "[real](docs/README.md)"].join("\n"),
    ),
    ["docs/README.md"],
  )
  // Leaving a nested quote level ends the fence opened at that level.
  assert.deepEqual(
    localLinkTargets(
      ["> > ```", "> > literal", "> [real](docs/README.md)"].join("\n"),
    ),
    ["docs/README.md"],
  )
  // A code span never pairs across a blank line.
  assert.deepEqual(
    localLinkTargets(
      [
        "unmatched ` in one paragraph",
        "",
        "[real](docs/README.md)",
        "",
        "closing ` in another paragraph",
      ].join("\n"),
    ),
    ["docs/README.md"],
  )
})

test("all local Markdown links and fragments resolve", async () => {
  const failures = []
  const anchorCache = new Map()
  for (const file of await collectMarkdownFiles(root)) {
    const markdown = await readFile(file, "utf8")
    for (const rawTarget of localLinkTargets(markdown)) {
      const [pathAndQuery, rawFragment = ""] = rawTarget.split("#", 2)
      const targetWithoutFragment = pathAndQuery.split("?", 1)[0]
      const target = path.resolve(
        path.dirname(file),
        decodeURIComponent(targetWithoutFragment || path.basename(file)),
      )
      try {
        await stat(target)
      } catch {
        failures.push(
          `${path.relative(root, file)} -> ${rawTarget}`,
        )
        continue
      }

      if (rawFragment && target.endsWith(".md")) {
        let anchors = anchorCache.get(target)
        if (!anchors) {
          anchors = markdownAnchors(await readFile(target, "utf8"))
          anchorCache.set(target, anchors)
        }
        const fragment = decodeURIComponent(rawFragment)
        if (!anchors.has(fragment)) {
          failures.push(
            `${path.relative(root, file)} -> ${rawTarget} (missing fragment)`,
          )
        }
      }
    }
  }

  assert.deepEqual(failures, [])
})

test("all fenced JSON examples parse", async () => {
  const failures = []
  for (const file of await collectMarkdownFiles(root)) {
    const markdown = await readFile(file, "utf8")
    const blocks = [...markdown.matchAll(/```json\s*\n([\s\S]*?)```/g)]
    for (const [index, match] of blocks.entries()) {
      try {
        JSON.parse(match[1])
      } catch (error) {
        failures.push(
          `${path.relative(root, file)} block ${index + 1}: ${error.message}`,
        )
      }
    }
  }

  assert.deepEqual(failures, [])
})
