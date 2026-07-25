import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  assertRemoteTagMatches,
  assertAutomationPullRequest,
  assertRecoveredReleasePullRequest,
  createMergePullRequestArguments,
  createReleaseBranchName,
  createReleaseCommitArguments,
  deleteRemoteReleaseBranch,
  ensureReleaseBranch,
  findPendingReleaseMerge,
  getRemoteTagState,
  inspectReleaseMergeCommit,
  parseAutomaticReleaseContext,
  releaseBaseCoversSource,
  resolveReleaseMergeCommit,
  waitForReleaseBaseCi
} from './automatic-release-pr.mjs'

const sourceSha = 'a'.repeat(40)
const releaseSha = 'b'.repeat(40)
const baseSha = 'c'.repeat(40)
const mergeSha = 'd'.repeat(40)
const skipMarkerPattern =
  /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|skip-checks/iu

test('accepts only successful main push CI from the current repository', () => {
  const context = parseAutomaticReleaseContext({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'everton-dgn/llm-router',
    RELEASE_SOURCE_BRANCH: 'main',
    RELEASE_SOURCE_CONCLUSION: 'success',
    RELEASE_SOURCE_EVENT: 'push',
    RELEASE_SOURCE_REPOSITORY: 'everton-dgn/llm-router',
    RELEASE_SOURCE_RUN_ID: '42',
    RELEASE_SOURCE_SHA: sourceSha
  })
  assert.equal(context.owner, 'everton-dgn')
  assert.equal(context.sourceSha, sourceSha)

  assert.throws(
    () =>
      parseAutomaticReleaseContext({
        ...process.env,
        GITHUB_ACTIONS: 'true',
        GITHUB_REPOSITORY: 'everton-dgn/llm-router',
        RELEASE_SOURCE_BRANCH: 'main',
        RELEASE_SOURCE_CONCLUSION: 'success',
        RELEASE_SOURCE_EVENT: 'pull_request',
        RELEASE_SOURCE_REPOSITORY: 'attacker/fork',
        RELEASE_SOURCE_RUN_ID: '42',
        RELEASE_SOURCE_SHA: sourceSha
      }),
    /current GitHub repository/
  )
})

test('derives a safe branch only from validated SemVer and source SHA', () => {
  assert.equal(
    createReleaseBranchName('0.1.0', sourceSha),
    `automation/release-v0.1.0-${sourceSha.slice(0, 12)}`
  )
  assert.throws(
    () => createReleaseBranchName('0.1.0;echo unsafe', sourceSha),
    /Unsupported release version/
  )
})

test('reads annotated and missing remote tags', () => {
  const objectId = 'c'.repeat(40)
  const commit = 'd'.repeat(40)
  let call = 0
  assert.deepEqual(
    getRemoteTagState('v0.1.0', () => {
      call += 1
      return call === 1
        ? `${objectId}\trefs/tags/v0.1.0`
        : `${commit}\trefs/tags/v0.1.0^{}`
    }),
    { commit, objectId }
  )
  assert.deepEqual(
    getRemoteTagState('v0.1.0', () => {
      throw new Error('missing')
    }),
    { commit: '', objectId: '' }
  )
})

test('accepts only the bot PR with the exact base, head and SHA', () => {
  const branch = createReleaseBranchName('0.1.0', sourceSha)
  const pullRequest = {
    base: {
      ref: 'main',
      repo: { full_name: 'everton-dgn/llm-router' }
    },
    head: {
      ref: branch,
      repo: { full_name: 'everton-dgn/llm-router' },
      sha: releaseSha
    },
    number: 7,
    state: 'open',
    user: { login: 'github-actions[bot]' }
  }
  assert.equal(
    assertAutomationPullRequest({
      branch,
      pullRequest,
      releaseSha,
      repository: 'everton-dgn/llm-router'
    }),
    pullRequest
  )
  assert.throws(
    () =>
      assertAutomationPullRequest({
        branch,
        pullRequest: {
          ...pullRequest,
          user: { login: 'external-contributor' }
        },
        releaseSha,
        repository: 'everton-dgn/llm-router'
      }),
    /unexpected author/
  )
})

test('recovers only a merge introduced by the exact automatic release PR', () => {
  const branch = createReleaseBranchName('0.1.0', sourceSha)
  const pullRequest = {
    base: {
      ref: 'main',
      repo: { full_name: 'everton-dgn/llm-router' }
    },
    head: {
      ref: branch,
      repo: { full_name: 'everton-dgn/llm-router' },
      sha: releaseSha
    },
    merge_commit_sha: mergeSha,
    merged_at: '2026-07-23T08:00:00Z',
    number: 7,
    state: 'closed',
    user: { login: 'github-actions[bot]' }
  }
  assert.equal(
    assertRecoveredReleasePullRequest({
      mergeSha,
      pullRequests: [pullRequest],
      releaseSha,
      repository: 'everton-dgn/llm-router',
      sourceSha,
      version: '0.1.0'
    }),
    pullRequest
  )
  assert.throws(
    () =>
      assertRecoveredReleasePullRequest({
        mergeSha,
        pullRequests: [{
          ...pullRequest,
          user: { login: 'external-contributor' }
        }],
        releaseSha,
        repository: 'everton-dgn/llm-router',
        sourceSha,
        version: '0.1.0'
      }),
    /unexpected author/
  )
  assert.throws(
    () =>
      assertRecoveredReleasePullRequest({
        mergeSha,
        pullRequests: [{
          ...pullRequest,
          merge_commit_sha: baseSha
        }],
        releaseSha,
        repository: 'everton-dgn/llm-router',
        sourceSha,
        version: '0.1.0'
      }),
    /exactly one associated/
  )
})

test('merges only with normal merge and the exact release SHA', () => {
  const branch = createReleaseBranchName('0.1.0', sourceSha)
  const args = createMergePullRequestArguments({
    branch,
    number: 7,
    releaseSha,
    repository: 'everton-dgn/llm-router',
    tag: 'v0.1.0'
  })
  assert.ok(args.includes(`sha=${releaseSha}`))
  assert.ok(args.includes('merge_method=merge'))
  assert.equal(args.some(argument => /squash|rebase|approve/iu.test(argument)), false)
  assert.equal(args.some(argument => skipMarkerPattern.test(argument)), false)
})

test('keeps the release subject exact while skipping the redundant pull request run', () => {
  const args = createReleaseCommitArguments({ tag: 'v0.1.0' })
  assert.deepEqual(args, [
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'chore(release): cut v0.1.0',
    '-m',
    '[skip ci]'
  ])
  const subject = args[args.indexOf('commit') + 2]
  assert.equal(subject, 'chore(release): cut v0.1.0')
  assert.equal(skipMarkerPattern.test(subject), false)
  assert.equal(
    args.filter(argument => skipMarkerPattern.test(argument)).length,
    1
  )
  assert.throws(
    () => createReleaseCommitArguments({ tag: '0.1.0' }),
    /Unsupported release tag/u
  )
  assert.throws(
    () => createReleaseCommitArguments({ tag: 'v0.1.0-rc.1' }),
    /Unsupported release tag/u
  )
})

test('uses the actual merge commit for new and recovered merged PRs', () => {
  assert.equal(
    resolveReleaseMergeCommit({
      merge: { merged: true, sha: mergeSha },
      pullRequest: { merged_at: null, number: 7 }
    }),
    mergeSha
  )
  assert.equal(
    resolveReleaseMergeCommit({
      pullRequest: {
        merge_commit_sha: mergeSha,
        merged_at: '2026-07-23T08:00:00Z',
        number: 7
      }
    }),
    mergeSha
  )
  assert.throws(
    () =>
      resolveReleaseMergeCommit({
        merge: { merged: false, sha: mergeSha },
        pullRequest: { merged_at: null, number: 7 }
      }),
    /did not merge/
  )
})

test('validates the release merge shape and payload against its first parent', () => {
  const calls = []
  const result = inspectReleaseMergeCommit({
    isAncestor(ancestor, descendant) {
      assert.equal(ancestor, sourceSha)
      assert.equal(descendant, baseSha)
      return true
    },
    mergeSha,
    releaseSha,
    runGit(args) {
      calls.push(args)
      const command = args.join(' ')
      if (command === `rev-list --parents -n 1 ${mergeSha}`) {
        return `${mergeSha} ${baseSha} ${releaseSha}`
      }
      if (command === `rev-list --parents -n 1 ${releaseSha}`) {
        return `${releaseSha} ${sourceSha}`
      }
      if (command === `log -1 --format=%s ${releaseSha}`) {
        return 'chore(release): cut v0.1.0'
      }
      if (command === `diff --name-only ${baseSha} ${mergeSha}`) {
        return 'CHANGELOG.md\npackage.json'
      }
      if (command === `diff --name-only ${sourceSha} ${releaseSha}`) {
        return 'CHANGELOG.md\npackage.json'
      }
      if (
        command === `rev-parse --verify ${mergeSha}:package.json` ||
        command === `rev-parse --verify ${releaseSha}:package.json`
      ) {
        return '1'.repeat(40)
      }
      if (
        command === `rev-parse --verify ${mergeSha}:CHANGELOG.md` ||
        command === `rev-parse --verify ${releaseSha}:CHANGELOG.md`
      ) {
        return '2'.repeat(40)
      }
      if (command === `show ${mergeSha}:package.json`) {
        return JSON.stringify({ name: 'llm-router', version: '0.1.0' })
      }
      if (command === `show ${baseSha}:package.json`) {
        return JSON.stringify({ name: 'llm-router', version: '0.0.0' })
      }
      if (command === `show ${sourceSha}:package.json`) {
        return JSON.stringify({ name: 'llm-router', version: '0.0.0' })
      }
      if (command === `show ${mergeSha}:CHANGELOG.md`) {
        return '# Changelog\n\n## 0.1.0 - 2026-07-23\n\n- Test release.\n'
      }
      if (command === `show ${releaseSha}:CHANGELOG.md`) {
        return '# Changelog\n\n## 0.1.0 - 2026-07-23\n\n- Test release.\n'
      }
      throw new Error(`Unexpected git call: ${command}`)
    },
    tag: 'v0.1.0'
  })
  assert.deepEqual(result, {
    baseSha,
    mergeSha,
    releaseSha,
    sourceSha,
    version: '0.1.0'
  })
  assert.deepEqual(calls[0], [
    'rev-list',
    '--parents',
    '-n',
    '1',
    mergeSha
  ])
})

test('rejects a release commit that is not the merge second parent', () => {
  assert.throws(
    () =>
      inspectReleaseMergeCommit({
        mergeSha,
        releaseSha,
        runGit(args) {
          if (args[0] === 'rev-list') {
            return `${mergeSha} ${baseSha} ${'e'.repeat(40)}`
          }
          throw new Error('unexpected call')
        },
        tag: 'v0.1.0'
      }),
    /second parent/
  )
})

test('rejects a release source outside the merge base ancestry', () => {
  assert.throws(
    () =>
      inspectReleaseMergeCommit({
        isAncestor() {
          return false
        },
        mergeSha,
        releaseSha,
        runGit(args) {
          const command = args.join(' ')
          if (command === `rev-list --parents -n 1 ${mergeSha}`) {
            return `${mergeSha} ${baseSha} ${releaseSha}`
          }
          if (command === `rev-list --parents -n 1 ${releaseSha}`) {
            return `${releaseSha} ${sourceSha}`
          }
          throw new Error(`Unexpected git call: ${command}`)
        },
        tag: 'v0.1.0'
      }),
    /must be an ancestor/
  )
})

test('finds one valid untagged release merge before planning another version', () => {
  const changelog =
    '# Changelog\n\n## 0.1.0 - 2026-07-23\n\n- Test release.\n'
  const result = findPendingReleaseMerge({
    getTagState(tag) {
      assert.equal(tag, 'v0.1.0')
      return { commit: '', objectId: '' }
    },
    isAncestor(ancestor, descendant) {
      return ancestor === sourceSha && descendant === baseSha
    },
    runGit(args) {
      const command = args.join(' ')
      if (
        command ===
          'tag --merged origin/main --list v* --sort=-version:refname'
      ) {
        return ''
      }
      if (command === 'rev-list --first-parent --merges origin/main') {
        return mergeSha
      }
      if (command === `rev-list --parents -n 1 ${mergeSha}`) {
        return `${mergeSha} ${baseSha} ${releaseSha}`
      }
      if (command === `rev-list --parents -n 1 ${releaseSha}`) {
        return `${releaseSha} ${sourceSha}`
      }
      if (command === `log -1 --format=%s ${releaseSha}`) {
        return 'chore(release): cut v0.1.0'
      }
      if (
        command === `diff --name-only ${baseSha} ${mergeSha}` ||
        command === `diff --name-only ${sourceSha} ${releaseSha}`
      ) {
        return 'CHANGELOG.md\npackage.json'
      }
      if (
        command === `rev-parse --verify ${mergeSha}:package.json` ||
        command === `rev-parse --verify ${releaseSha}:package.json`
      ) {
        return '1'.repeat(40)
      }
      if (
        command === `rev-parse --verify ${mergeSha}:CHANGELOG.md` ||
        command === `rev-parse --verify ${releaseSha}:CHANGELOG.md`
      ) {
        return '2'.repeat(40)
      }
      if (command === `show ${mergeSha}:package.json`) {
        return JSON.stringify({ name: 'llm-router', version: '0.1.0' })
      }
      if (
        command === `show ${baseSha}:package.json` ||
        command === `show ${sourceSha}:package.json`
      ) {
        return JSON.stringify({ name: 'llm-router', version: '0.0.0' })
      }
      if (
        command === `show ${mergeSha}:CHANGELOG.md` ||
        command === `show ${releaseSha}:CHANGELOG.md`
      ) {
        return changelog
      }
      throw new Error(`Unexpected git call: ${command}`)
    }
  })
  assert.deepEqual(result, {
    baseSha,
    mergeSha,
    releaseSha,
    sourceSha,
    tag: 'v0.1.0',
    version: '0.1.0'
  })
})

test('searches pending merges only after the latest stable tag', () => {
  const calls = []
  const result = findPendingReleaseMerge({
    runGit(args) {
      const command = args.join(' ')
      calls.push(command)
      if (
        command ===
          'tag --merged origin/main --list v* --sort=-version:refname'
      ) {
        return 'v0.1.0'
      }
      if (
        command ===
          'rev-list --first-parent --merges v0.1.0..origin/main'
      ) {
        return ''
      }
      throw new Error(`Unexpected git call: ${command}`)
    }
  })
  assert.equal(result, null)
  assert.equal(
    calls.includes(
      'rev-list --first-parent --merges v0.1.0..origin/main'
    ),
    true
  )
})

test('continues after recovery when the triggering source is not covered', () => {
  assert.equal(
    releaseBaseCoversSource({
      baseSha,
      isAncestor(ancestor, descendant) {
        return ancestor === sourceSha && descendant === baseSha
      },
      sourceSha
    }),
    true
  )
  assert.equal(
    releaseBaseCoversSource({
      baseSha,
      isAncestor() {
        return false
      },
      sourceSha: mergeSha
    }),
    false
  )
})

test('creates a release branch only while its remote ref remains absent', () => {
  const branch = createReleaseBranchName('0.1.0', sourceSha)
  const pushes = []
  ensureReleaseBranch(branch, releaseSha, {
    getRemoteCommit() {
      return ''
    },
    push(args) {
      pushes.push(args)
    }
  })
  assert.deepEqual(pushes, [[
    'push',
    'origin',
    `--force-with-lease=refs/heads/${branch}:`,
    `${releaseSha}:refs/heads/${branch}`
  ]])

  ensureReleaseBranch(branch, releaseSha, {
    getRemoteCommit() {
      return releaseSha
    },
    push() {
      throw new Error('must not push an existing matching branch')
    }
  })

  assert.throws(
    () =>
      ensureReleaseBranch(branch, releaseSha, {
        getRemoteCommit() {
          return baseSha
        },
        push() {
          throw new Error('must fail before pushing')
        }
      }),
    /points to/
  )
})

test('deletes only the expected automatic release branch SHA', () => {
  const branch = createReleaseBranchName('0.1.0', sourceSha)
  const pushes = []
  assert.equal(
    deleteRemoteReleaseBranch({
      branch,
      expectedSha: releaseSha,
      getRemoteCommit() {
        return releaseSha
      },
      push(args) {
        pushes.push(args)
      }
    }),
    true
  )
  assert.deepEqual(pushes, [[
    'push',
    'origin',
    `--force-with-lease=refs/heads/${branch}:${releaseSha}`,
    `:refs/heads/${branch}`
  ]])
  assert.throws(
    () =>
      deleteRemoteReleaseBranch({
        branch,
        expectedSha: releaseSha,
        getRemoteCommit() {
          return baseSha
        },
        push() {
          throw new Error('must not push')
        }
      }),
    /points to/
  )
})

test('requires the remote annotated tag object and commit to match locally', () => {
  const localObjectId = 'e'.repeat(40)
  assert.deepEqual(
    assertRemoteTagMatches({
      localObjectId,
      remoteTag: {
        commit: mergeSha,
        objectId: localObjectId
      },
      tag: 'v0.1.0',
      targetSha: mergeSha
    }),
    {
      commit: mergeSha,
      objectId: localObjectId
    }
  )
  assert.throws(
    () =>
      assertRemoteTagMatches({
        localObjectId,
        remoteTag: {
          commit: mergeSha,
          objectId: 'f'.repeat(40)
        },
        tag: 'v0.1.0',
        targetSha: mergeSha
      }),
    /does not match local object/
  )
})

test('waits for CI on a concurrently advanced release base', () => {
  const ciCalls = []
  const waits = []
  const result = waitForReleaseBaseCi({
    assertCi(args) {
      ciCalls.push(args)
      if (ciCalls.length < 3) {
        throw new Error(
          `Commit ${args.head} needs a successful completed CI run on main before release`
        )
      }
      return { repository: 'everton-dgn/llm-router', runId: 99 }
    },
    attempts: 3,
    baseSha,
    context: {
      runId: '42',
      sourceSha
    },
    wait(milliseconds) {
      waits.push(milliseconds)
    }
  })
  assert.equal(result.runId, 99)
  assert.deepEqual(ciCalls, [
    { expectedRunId: undefined, head: baseSha },
    { expectedRunId: undefined, head: baseSha },
    { expectedRunId: undefined, head: baseSha }
  ])
  assert.deepEqual(waits, [10_000, 10_000])
})

test('pins CI to the triggering run when the merge base did not advance', () => {
  const calls = []
  waitForReleaseBaseCi({
    assertCi(args) {
      calls.push(args)
      return { repository: 'everton-dgn/llm-router', runId: 42 }
    },
    baseSha: sourceSha,
    context: {
      runId: '42',
      sourceSha
    },
    wait() {
      throw new Error('must not wait')
    }
  })
  assert.deepEqual(calls, [
    { expectedRunId: '42', head: sourceSha }
  ])
})

test('workflow confines write permissions to the automatic release job', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/auto-release.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /^permissions: \{\}$/mu)
  assert.match(workflow, /workflow_run:/u)
  assert.match(workflow, /github\.event\.workflow_run\.event == 'push'/u)
  assert.match(
    workflow,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/u
  )
  assert.match(
    workflow,
    /permissions:\n\s+actions: read\n\s+contents: write\n\s+pull-requests: write/u
  )
  assert.doesNotMatch(workflow, /pull_request_target|write-all|pnpm install/u)
  assert.doesNotMatch(workflow, /--squash|--rebase|--force/u)
  for (const match of workflow.matchAll(/uses:\s+\S+@(\S+)/gu)) {
    assert.match(match[1], /^[0-9a-f]{40}$/u)
  }
})

test('CI stays on the events that honor the release skip marker', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8'
  )
  assert.match(workflow, /^ {2}pull_request:$/mu)
  assert.doesNotMatch(workflow, /pull_request_target/u)
})
