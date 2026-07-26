# Release process

Stable releases use SemVer tags in the form `vX.Y.Z`. A successful CI run for a
push to `main` starts `.github/workflows/auto-release.yml`. No maintainer command
is required.

The private root `package.json` is the single version source. The project does
not publish an npm package or workspace.

## Automatic flow

The release job performs this sequence:

1. Accepts only a successful `CI` workflow run caused by a push to `main` in
   this repository.
2. Checks out the exact commit and verifies the exact workflow run through the
   GitHub API.
3. Reads non-merge Conventional Commits after the latest stable tag.
4. Derives the next version and generates the matching `CHANGELOG.md` section.
5. Creates `chore(release): cut vX.Y.Z`, changing only `package.json` and,
   when needed, `CHANGELOG.md`. The commit subject stays exact, and its body
   carries `[skip ci]`.
6. Pushes a source-specific `automation/release-*` branch and opens a normal
   pull request authored by `github-actions[bot]`.
7. Revalidates the PR author, repository, base branch, head branch, and exact
   commit SHA.
8. Merges through the GitHub API with `merge_method=merge`. Squash and rebase
   are never used.
9. Validates the returned merge commit, including its release head, first
   parent, release-only payload, and base CI.
10. Creates an annotated tag on the validated merge commit, creates or updates
    the GitHub Release from `CHANGELOG.md`, and removes the automation branch.

The generated pull request is merged immediately without a second CI run. The
source commit has already passed the full `CI` workflow, and the release commit
is restricted to deterministic version and changelog output covered by the
release test suite. The tag points to the normal merge commit on `main`, not to
the release branch head.

The release commit body carries `[skip ci]` so that no pull-request run is
created at all. A pull request opened with `GITHUB_TOKEN` can produce a run
that waits for maintainer approval, and a maintainer would only release it
after the merge, the tag, and the GitHub Release already exist.

That outcome is intermittent rather than guaranteed: of the four release pull
requests opened so far, all identical in author and timing, only the one for
v1.1.0 produced such a run. The marker is a cheap defense against the case, not
a fix for a behavior that happens every time. Audit a suspect run with
`gh api /repos/<owner>/<repo>/actions/runs/<id>/attempts/1 --jq '.conclusion'`,
because the top-level run object hides a retained first attempt.

Commits that do not require a release stop before creating a branch or pull
request.

## Version rules

| Commit | Automatic bump |
| --- | --- |
| `fix:`, `perf:`, dependency-scoped `build:` or `chore:`, or an unmatched Git revert | patch |
| `feat:` | minor |
| `type!:` or a `BREAKING CHANGE:` footer | major |
| `docs:`, other `chore:` or `build:`, `refactor:`, `style:`, `test:` or `ci:` | none |

Dependency scopes are `deps` and `deps-dev`. Dependabot uses `fix(deps):`.
The parser also treats `chore(deps):`, `chore(deps-dev):`, `build(deps):`, and
`build(deps-dev):` as patch changes.

Generated entries treat commit prose as untrusted text. Active links,
`@mentions`, issue references, HTML, and Markdown formatting are neutralized
before they reach `CHANGELOG.md` or a GitHub Release. Valid inline code spans
remain readable.

The root manifest uses `0.0.0` as the unpublished sentinel. The first
release-worthy history is promoted directly to `1.0.0`. Later releases require
`package.json` to match the latest stable tag and follow the bump table above.

## Local checks

Preview the next version from a clean, synchronized local `main`:

```bash
git switch main
git pull --ff-only
pnpm release:next
```

The command is read-only. It prints `none` or one version such as `1.0.0`.

Run the release unit tests with:

```bash
pnpm test:release
```

Run every local test, including the live routing evaluation, with:

```bash
pnpm release:check
```

There is no local command that commits, tags, pushes, or publishes a release.

## Concurrency and recovery

All automatic release runs share one non-cancelling concurrency group. If
`main` advances before the generated PR is merged, the job closes its PR,
removes its branch, and lets the newer CI run derive the release again.

GitHub can accept another trusted update to `main` between the final pre-merge
check and the merge API call. After merging, the job treats the returned merge
commit as the release boundary. It verifies the release branch as its second
parent, verifies the release-only payload relative to its first parent, and
requires successful CI for the first parent before creating a tag. A failed or
unverifiable condition stops publication.

The process is idempotent across the main failure points:

- Before merge, a retry reuses the exact branch and PR after validating them.
- After merge but before tag creation, a retry finds the validated untagged
  normal merge before calculating another version, verifies that GitHub
  associates it with the exact bot-authored automation PR, and uses it as the
  tag target. If the triggering source contains later release-worthy commits,
  the same run continues planning from the recovered tag.
- After tag creation, a retry verifies the tag and creates or updates the
  missing GitHub Release.
- After publication, a retry removes a matching leftover automation branch.
- An existing remote branch or tag must point to the exact expected commit.
  Any mismatch fails closed.

Branch creation requires the remote ref to remain absent, and branch cleanup
checks the exact remote SHA before deleting with a matching Git lease. Tag
publication checks both the peeled commit and annotated-tag object ID before
and after the push.

Do not move or reuse a published stable tag. If recovery cannot validate the
existing branch, PR, commit, or tag, inspect the failed workflow and repository
state before making a manual change.

If a concurrently merged base has a permanently failing CI run, the release
stays untagged. The workflow will not publish code that lacks a successful CI
run for that exact base. Repair this state through a reviewed recovery change;
do not move the pending tag or bypass the CI check.

## Permissions and repository settings

The workflow has no top-level token permissions. Only the `release` job gets:

```yaml
permissions:
  actions: read
  contents: write
  pull-requests: write
```

`actions: read` verifies the source CI run. `contents: write` pushes the
automation branch and annotated tag. `pull-requests: write` creates and merges
the generated PR.

Repository settings must allow GitHub Actions to create and approve pull
requests. The workflow does not approve its PR, but GitHub applies the same
setting to PR creation. Native GitHub auto-merge is not required.

Fork pull requests cannot start the privileged release job and do not receive
its token. The workflow accepts only a successful `push` run on `main` whose
source repository equals the current repository. A fork contribution becomes
eligible only after a maintainer merges it into `main` and that resulting push
passes CI. Contributors without repository write access cannot merge their own
pull requests.

## Release notes fallback

The automatic workflow creates or updates the GitHub Release directly because
events created with `GITHUB_TOKEN` do not start another workflow run.

A tag pushed by the release job never starts a second workflow either, so
`.github/workflows/release-notes-sync.yml` carries no tag trigger.

That workflow remains available as a manual repair tool. Start it from the
Actions tab through `workflow_dispatch`, pass the stable tag, and enable
`create_if_missing` when the GitHub Release is absent. It requires an annotated
tag on either a normal release merge or a compatible legacy release commit and
applies the same reachability, release-payload, base-CI, and remote-tag checks
before writing release notes. It rewrites the release body from `CHANGELOG.md`
at the tagged commit, so it replaces any manual edit.
