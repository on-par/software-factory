# Runbook: npm trusted publishing (OIDC)

`.github/workflows/publish.yml` publishes the packages listed in
`scripts/publish-workspaces.txt` when a `v*` tag is pushed, and publishes the next
`X.Y.Z-next.N` prerelease to the `next` dist-tag on every push to `main` (see
`scripts/publish-release.sh`). Authentication comes from npm trusted
publishing (GitHub OIDC), so no long-lived npm token is involved. This
replaces the `NPM_TOKEN` repo secret.

## Set up the trusted publisher

Do this once for each of the seven packages:

- `@on-par/adr-kit`
- `@on-par/contracts`
- `@on-par/repo-context`
- `@on-par/factory-config`
- `@on-par/factory-core`
- `@on-par/factory-tui`
- `@on-par/factory-cli`

Steps:

1. Sign in at npmjs.com as a maintainer of the package and open the package's
   **Settings** tab.
2. Under **Trusted Publisher**, choose **GitHub Actions**.
3. Fill in these values:

   | Field                | Value                                                  |
   | -------------------- | ------------------------------------------------------ |
   | Organization or user | `on-par`                                               |
   | Repository           | `software-factory`                                     |
   | Workflow filename    | `publish.yml` (filename only, no `.github/workflows/`) |
   | Environment name     | leave blank (the publish job uses no environment)      |

4. Save. Optionally, under **Publishing access**, choose "Require two-factor
   authentication and disallow tokens", but only after the first OIDC publish
   has succeeded.

## Verify a tag publish

No classic token is needed or used.

- Watch the Publish run for the tag. The job summary shows a
  `PUBLISHED <name@version ...>` line for each package.
- On each package page on npmjs.com, the new version shows the **provenance**
  badge, which links to the `publish.yml` run and commit. Optionally, run
  `npm view @on-par/factory-cli@<version> --json` and check the
  `dist.attestations` field, or run `npm audit signatures` in a project that
  installs it.
- In the package's **Settings → Trusted Publisher**, the publisher no longer
  shows as pending after its first successful use.

## If OIDC fails

- **npm CLI version.** Trusted publishing needs npm >= 11.5.1 (Node >= 22.14).
  Add `npm --version` to the job log to check. The workflow uses Node 24; if
  its bundled npm is too old, upgrade npm in the job.
- **Workflow filename binding.** The trusted publisher is bound to the
  filename `publish.yml`. Renaming the workflow, or publishing from a
  different workflow file, is rejected. A mismatch shows up as a 404 or
  `ENEEDAUTH` error on `npm publish`.
- **`id-token: write` permission.** The publish job's `permissions:` block
  must include `id-token: write`. Without it no OIDC token is minted.
- **Org, repo and environment.** The organization and repository must match
  exactly (`on-par` / `software-factory`), and the environment field must be
  blank because the job uses no environment.
- **Runner.** It must run on GitHub-hosted runners. Self-hosted runners are
  not supported.
- **Partial publish.** A failure partway through leaves earlier packages
  already published. A rerun skips them, as `scripts/publish-release.sh`
  notes.
- Don't fall back to pasting a token into the docs or the workflow.

## Retiring `NPM_TOKEN`

Deleting the `NPM_TOKEN` repo secret is a separate manual step for a repo
admin, done after an OIDC publish has been verified.
