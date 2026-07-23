import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const manifestPaths = ["package.json", "opencode/package.json"]
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u

test("all direct dependencies use exact versions", async () => {
  const failures = []

  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    for (const field of dependencyFields) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (!exactVersion.test(version)) {
          failures.push(`${manifestPath}:${field}:${name}:${version}`)
        }
      }
    }
  }

  assert.deepEqual(failures, [])
})

test("the package manager uses an exact version", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"))

  assert.match(manifest.packageManager, /^pnpm@\d+\.\d+\.\d+$/u)
})
