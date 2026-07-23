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
  ".serena",
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

function localLinkTargets(markdown) {
  const targets = []
  const pattern = /!?\[[^\]]*]\(([^)]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
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
