# Scoped GitHub credentials

The factory gives each run phase its own GitHub credential, scoped to the one target repo and that phase's minimum permissions. Only the land step, after the trust-tier risk gate allows it, can merge. See [ADR-0178](../adr/0178-scoped-github-credentials-per-phase.md).

| Phase | Permissions                                                                                    | Merge |
| ----- | ---------------------------------------------------------------------------------------------- | ----- |
| plan  | metadata read, contents read, issues write, pull requests read                                 | no    |
| build | none                                                                                           | no    |
| check | unchanged (the existing credential)                                                            | no    |
| ship  | metadata read, contents write, issues write, pull requests write, checks/statuses/actions read | no    |
| land  | same as ship                                                                                   | yes   |

## GitHub App (preferred)

1. Create a GitHub App with exactly those repository permissions: Metadata (read), Contents (write), Issues (write), Pull requests (write), Checks (read), Commit statuses (read), Actions (read). Do not grant Administration or Workflows.
2. Install it on the target repo only.
3. Add the ids to `.factory/config.yaml`:

   ```yaml
   github:
     credentials:
       app: { appId: 123456, installationId: 7890123 }
   ```

4. Export the private key PEM as `FACTORY_GITHUB_APP_PRIVATE_KEY`. It is never read from config.

Each phase mints an installation token limited to the target repo and the phase's permissions, and revokes it when the next phase starts. A missing key or a refused mint fails the phase; the factory never falls back to your ambient token.

## Fine-grained tokens (fallback)

Without an App, set one fine-grained personal access token per phase, each limited to the target repo with the permissions in the table:

- `FACTORY_GITHUB_TOKEN_PLAN`
- `FACTORY_GITHUB_TOKEN_SHIP`
- `FACTORY_GITHUB_TOKEN_LAND`

A missing token for a phase fails that phase. Fine-grained tokens cannot be revoked per phase.

## Ambient token

`github.credentials.allowAmbientToken: true` opts in to your broad `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`. With no scoped credential configured and no opt-in, the ambient token is still used for now: the run logs a `github_credentials_ambient` warn event and a later release will fail instead (ADR-0160).

## factory doctor

`factory doctor` shows a `GitHub credential source` row. It is ok for an App or fine-grained setup and an optional warning for the ambient token. The row never fails doctor's exit code.

## Limits

`git push` still uses your git credentials, `gh pr merge --admin` is unchanged, and `contents: write` relies on branch protection to protect unprotected branches.
