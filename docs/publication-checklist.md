# Public repository checklist

The repository must remain private until every pre-publication item below is
complete. Changing repository visibility requires a separate, explicit
approval from the owner.

## Before changing visibility

- Merge the release-readiness branch through the normal pull request workflow.
- Record the required `main` checks: `Commit messages` and every CI test matrix
  check. The current private repository plan does not expose branch protection,
  so these rules must be enabled in the publication maintenance window.
- Confirm that the latest `main` commit has a successful CI run.
- Review the repository description, topics, default branch, issue templates,
  pull request template, license, contribution guide, Code of Conduct, support
  policy, and security policy.
- Confirm that no tracked file contains credentials, private benchmark output,
  local configuration, or user data.
- Confirm that package and action dependencies are pinned by the lockfiles or
  immutable action commit SHAs.

## Visibility change and security channel

Perform these steps in one maintenance window:

1. Obtain explicit approval to make `everton-dgn/llm-router` public.
2. Change the repository visibility to public.
3. Enable GitHub private vulnerability reporting in the repository security
   settings, or run:

   ```bash
   gh api \
     --method PUT \
     repos/everton-dgn/llm-router/private-vulnerability-reporting
   ```

4. Verify the setting:

   ```bash
   gh api repos/everton-dgn/llm-router/private-vulnerability-reporting
   ```

5. Open the private report form and confirm that it is available:
   `https://github.com/everton-dgn/llm-router/security/advisories/new`.
6. Enable branch protection or a repository ruleset for `main`, requiring the
   commit-message check and every CI matrix check.
7. Require GitHub Actions to use immutable commit SHAs.
8. Verify that the issue chooser routes security reports to the private form.

If private vulnerability reporting cannot be enabled and verified, change the
repository back to private and fix the security channel before announcing it.

## After publication

- Verify the GitHub community profile and every link in `README.md`.
- Confirm that Dependabot can read the GitHub Actions configuration,
  `pnpm-lock.yaml`, and `opencode/pnpm-lock.yaml`.
- Create the first stable tag only after the exact source commit has a
  successful CI run on `main`.
- Confirm that the tag workflow creates release notes from the matching
  `CHANGELOG.md` section.
- Test installation in a new clone, including the automatic Lefthook setup.
- Announce the project only after the security form, CI badge, issue forms, and
  installation path have been checked from an external account.
