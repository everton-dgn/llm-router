# Public repository checklist

This repository is public. Use this checklist when changing repository
settings, release automation, contribution paths, or public project metadata.

## Repository controls

- Keep the default branch on `main`.
- Keep the active `main` ruleset that blocks deletion and non-fast-forward
  updates and requires pull requests.
- Allow only normal merge commits. Do not enable squash or rebase merges.
  Either one would move the `[skip ci]` release commit body into the `main`
  head commit message, which stops the `CI` push run, stops the `workflow_run`
  trigger, and disables automatic releases with no visible error.
- Do not require status checks for the `CI` jobs on `main`. The release commit
  carries `[skip ci]`, and a skipped workflow leaves its checks pending, which
  would make the release pull request unmergeable.
- Keep GitHub Actions on read-only default permissions.
- Enable the repository setting that lets GitHub Actions create and approve
  pull requests. GitHub exposes creation and approval as one setting, although
  the automatic release workflow never calls an approval API.
- Pin third-party GitHub Actions to immutable commit SHAs.
- Review ruleset bypass actors after any collaborator or team change.

## Public project surface

- Review the repository description, topics, default branch, issue templates,
  pull request template, license, contribution guide, Code of Conduct, support
  policy, and security policy.
- Confirm that no tracked file contains credentials, private benchmark output,
  local configuration, or user data.
- Confirm that package and action dependencies are pinned by the lockfiles or
  immutable action commit SHAs.
- Verify the GitHub community profile and every link in `README.md`.
- Test installation in a new clone, including the automatic Lefthook setup.

## Security reporting

Private vulnerability reporting must remain enabled. Verify it in the
repository security settings or with:

```bash
gh api repos/everton-dgn/llm-router/private-vulnerability-reporting
```

Open the private report form and confirm that it is available:
`https://github.com/everton-dgn/llm-router/security/advisories/new`.

The issue chooser must route vulnerability reports to the private form. Do not
ask reporters to disclose vulnerabilities in public issues.

## Automatic releases

Before changing `.github/workflows/auto-release.yml` or its release scripts:

- Read [RELEASE.md](RELEASE.md).
- Preserve the empty top-level `permissions` map.
- Grant `actions: read`, `contents: write`, and `pull-requests: write` only to
  the release job.
- Accept only a successful `CI` run caused by a same-repository push to `main`.
- Preserve the shared non-cancelling concurrency group.
- Preserve exact source-run, pull-request identity, merge topology, payload,
  tag, and source-CI validation.
- Use only `merge_method=merge`.
- Keep the annotated tag on the validated normal merge commit.
- Fail closed before tagging or publishing when an existing branch, pull
  request, merge commit, tag, or CI result does not match the expected state.

Fork pull requests do not receive the privileged release token and cannot
start the release job. After a maintainer merges a contribution, the resulting
same-repository `main` push must pass CI before it can enter the release flow.

Verify recovery behavior after changes: an interrupted run must reuse only
matching state, stale pre-merge work must be closed and removed, and a retry
after merge must recover the validated merge commit before creating or
repairing its tag and GitHub Release.

`.github/workflows/release-notes-sync.yml` is a manual repair path only. Keep
it on `workflow_dispatch` alone, because a tag pushed with `GITHUB_TOKEN` never
starts a workflow run, and keep `actions: read` on its job so that the tag
verification can read the base CI run.

## Dependency maintenance

- Keep Dependabot limited to GitHub Actions updates.
- Confirm that Dependabot can read every workflow in `.github/workflows/`.
- Review action updates for permission changes and keep immutable SHA pins.
- Run the deterministic CI gate before merging dependency updates.
