import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rename, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import { isSensitiveRepositoryPath, runRepositoryQuery } from "../opencode/lib/repo_query.mjs"

const execFileAsync = promisify(execFile)

async function git(cwd, ...argv) {
  return execFileAsync("git", argv, { cwd, encoding: "utf8" })
}

test("inspects repository data while excluding sensitive and escaping files", async () => {
  assert.equal(isSensitiveRepositoryPath(".env"), true)
  assert.equal(isSensitiveRepositoryPath("nested/.env.local"), true)
  assert.equal(isSensitiveRepositoryPath(".git/config"), true)
  const workspace = await mkdtemp(path.join(tmpdir(), "repo-query-workspace-"))
  const external = await mkdtemp(path.join(tmpdir(), "repo-query-external-"))
  try {
    await git(workspace, "init", "-q")
    await git(workspace, "config", "user.name", "Repo Query Test")
    await git(workspace, "config", "user.email", "repo-query@example.invalid")
    await writeFile(path.join(workspace, "small.txt"), "needle\n")
    await writeFile(path.join(workspace, "large.txt"), "one\ntwo\nthree\n")
    await writeFile(path.join(workspace, "secret.pem"), "never expose\n")
    await writeFile(path.join(external, "outside.txt"), "outside\n")
    await symlink(path.join(external, "outside.txt"), path.join(workspace, "escape.txt"))
    await symlink(path.join(workspace, "secret.pem"), path.join(workspace, "public.txt"))
    await git(workspace, "add", "small.txt", "large.txt", "secret.pem", "escape.txt", "public.txt")
    await git(workspace, "commit", "-q", "-m", "initial")
    await writeFile(path.join(workspace, "untracked.txt"), "draft\n")

    const listed = await runRepositoryQuery({ action: "files", max_results: 20 }, workspace)
    assert.deepEqual(listed.files, ["escape.txt", "large.txt", "public.txt", "small.txt"])
    assert.equal(listed.count, 5)
    assert.equal(listed.excluded_count, 1)
    const listedWithUntracked = await runRepositoryQuery(
      { action: "files", include_untracked: true, max_results: 20 },
      workspace,
    )
    assert.deepEqual(listedWithUntracked.files, ["escape.txt", "large.txt", "public.txt", "small.txt", "untracked.txt"])
    assert.equal(listedWithUntracked.count, 6)

    const read = await runRepositoryQuery({ action: "read_file", path: "small.txt" }, workspace)
    assert.deepEqual(read.lines[0], { number: 1, text: "needle" })
    await assert.rejects(
      runRepositoryQuery({ action: "read_file", path: "secret.pem" }, workspace),
      /unavailable, ignored, external, or sensitive/,
    )
    await assert.rejects(
      runRepositoryQuery({ action: "read_file", path: "public.txt" }, workspace),
      /unavailable, ignored, external, or sensitive/,
    )
    await assert.rejects(
      runRepositoryQuery({ action: "read_file", path: "..\/outside.txt" }, workspace),
      /stay inside/,
    )

    const searched = await runRepositoryQuery({ action: "search", query: "needle" }, workspace)
    assert.deepEqual(searched.matches, [{ path: "small.txt", line: 1, text: "needle" }])

    const largest = await runRepositoryQuery({ action: "largest_files_by_lines", max_results: 2 }, workspace)
    assert.deepEqual(largest.files, [
      { path: "large.txt", lines: 3 },
      { path: "small.txt", lines: 1 },
    ])

    await writeFile(path.join(workspace, "small.txt"), "needle changed\n")
    const status = await runRepositoryQuery({ action: "status" }, workspace)
    assert.deepEqual(status.unstaged, ["small.txt"])
    assert.deepEqual(status.untracked, ["untracked.txt"])
    const diff = await runRepositoryQuery({ action: "diff", path: "small.txt" }, workspace)
    assert.equal(diff.files.length, 1)
    assert.match(diff.files[0].diff, /needle changed/)

    const defaultDiff = await runRepositoryQuery({ action: "diff" }, workspace)
    assert.equal(defaultDiff.files.some((item) => item.path === "untracked.txt"), false)
    const diffWithUntracked = await runRepositoryQuery(
      { action: "diff", include_untracked: true },
      workspace,
    )
    assert.equal(diffWithUntracked.files.some((item) => item.path === "untracked.txt"), true)

    await rename(
      path.join(workspace, "large.txt"),
      path.join(external, "large.txt.moved"),
    )
    const deletedDiff = await runRepositoryQuery({ action: "diff", path: "large.txt" }, workspace)
    assert.equal(deletedDiff.files.length, 1)
    assert.match(deletedDiff.files[0].diff, /deleted file mode/)

    const log = await runRepositoryQuery({ action: "log", max_results: 1 }, workspace)
    assert.equal(log.commits.length, 1)
    assert.equal(log.commits[0].subject, "initial")
  } finally {
    await rename(workspace, `${workspace}.preserved`)
    await rename(external, `${external}.preserved`)
  }
})
