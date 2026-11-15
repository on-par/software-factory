# ADR-0178: Scoped GitHub credentials per phase, with no merge route outside land

- Status: Accepted
- Date: 2026-11-15
- Issue: #4120
- See also: [ADR-0160](0160-stricter-config-validation-warns-for-one-release-before-it-fails.md), [ADR-0170](0170-land-syncs-a-behind-pr-onto-current-main-and-merges-only-a-head-ci-verified-against-it-behind-strict-branch-protection.md), [ADR-0176](0176-the-factory-s-own-github-identity-covers-app-installation-tokens-and-own-comment-checks-match-that-exact-account.md)

## Context

The local path built one Octokit with the operator's ambient token and used it for every phase. A confused or compromised run could merge, change repo settings or touch other repos with that token. The hosted path already minted a per-job single-repo token but did not say which permissions it needed.

## Decision

1. **Phase matrix.** Each GitHub-touching phase gets a credential scoped to the one target repo and that phase's minimum permissions. The matrix lives in `packages/core/src/github-scope/matrix.ts` and is the source of truth.

   | Phase | metadata                                          | contents | issues | pull_requests | checks | statuses | actions | May merge |
   | ----- | ------------------------------------------------- | -------- | ------ | ------------- | ------ | -------- | ------- | --------- |
   | plan  | read                                              | read     | write  | read          | -      | -        | -       | no        |
   | build | none                                              | none     | none   | none          | none   | none     | none    | no        |
   | check | unchanged: the existing credential passes through |          |        |               |        |          |         | no        |
   | ship  | read                                              | write    | write  | write         | read   | read     | read    | no        |
   | land  | read                                              | write    | write  | write         | read   | read     | read    | yes       |

   Issue comments and labels, including PR labels and run-state comments, sit under `issues`. PLAN may write only under `/repos/{owner}/{repo}/issues` and run GraphQL queries. BUILD holds no GitHub credential, and its environment scrub stays. CHECK keeps its current access and behavior.

2. **Source precedence.** `resolveGitHubCredentialSource` picks one source and never mixes:
   1. `github.credentials.app` set: GitHub App installation tokens, minted per phase with `repositories` and `permissions` and revoked when the next phase starts. The private key comes only from `FACTORY_GITHUB_APP_PRIVATE_KEY`. A missing key fails closed.
   2. Any `FACTORY_GITHUB_TOKEN_PLAN`, `_SHIP` or `_LAND`: fine-grained tokens, one per phase. A missing phase token fails closed.
   3. `github.credentials.allowAmbientToken: true`: the ambient token, with a `github_credentials_ambient` warn event and a `factory doctor` row.
   4. Otherwise the ambient token, as the ADR-0160 warn stage.

   A configured scoped source never falls back to the ambient token.

3. **Guard rules.** `installGitHubScopeGuard` wraps every Octokit request. In order, it:
   1. throws the stored lease failure;
   2. refuses everything in BUILD;
   3. passes CHECK through on the existing credential;
   4. refuses requests to any repo other than the target;
   5. refuses the REST merge route and the `mergePullRequest` and `enablePullRequestAutoMerge` GraphQL mutations unless the phase is land and `allowScopedMerge` ran;
   6. refuses PLAN writes outside issues;
   7. injects the phase token and turns a 401 or 403 into a `GitHubScopeError` naming the missing permissions. It never retries on the ambient token.

   `landIssue` calls `allowScopedMerge` only after `enforceRiskAtLand` allows the merge, or when the existing policy skips the gate. The gate, trust tiers and the `gh pr merge --admin` path are unchanged.

4. **Hosted path.** The hosted mint input carries the ship permissions and the single target repository name.

5. **Redaction.** `ghs_` installation tokens match the existing token pattern. `FACTORY_GITHUB_TOKEN_PLAN`, `_SHIP` and `_LAND` and `FACTORY_GITHUB_APP_PRIVATE_KEY` are treated as GitHub credential env vars, so they are stripped from child environments and redacted from text.

6. **ADR-0160 warn stage.** Using the ambient token without `allowAmbientToken` logs a warn event and shows an optional `factory doctor` row now. The next release makes it an error.

## Residuals

- `git push` transport still uses the operator's git credentials; brokering git transport credentials is a follow-up.
- `gh pr merge --admin` is unchanged and runs outside the Octokit guard.
- Fine-grained tokens cannot be revoked per phase; their release is a no-op. Use the App source for per-phase revocation.
- `contents: write` lets SHIP push to any unprotected branch of the target repo. This relies on ADR-0170 strict branch protection.
- The guard covers the in-process Octokit client. A subprocess that reads its own ambient token is outside it; sandboxes cover that.

## Consequences

- A compromised PLAN, BUILD or SHIP run cannot merge or reach another repo through the factory's Octokit.
- Operators set up a GitHub App or per-phase tokens; see [docs/ops/github-credentials.md](../ops/github-credentials.md).
