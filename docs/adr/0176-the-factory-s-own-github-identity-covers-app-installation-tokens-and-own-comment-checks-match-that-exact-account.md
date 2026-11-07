# ADR-0176: The factory's own GitHub identity covers App installation tokens, and own-comment checks match that exact account

- Status: Accepted
- Date: 2026-11-06
- Amended: 2026-11-07 (the viewer query and the bot-acceptance rule of decision 2)
- See also: [ADR-0174](0174-a-run-persists-its-resumable-state-in-a-factory-owned-pr-comment.md) (PR run state trust), [ADR-0130](0130-auto-filed-bug-evidence-is-stripped-of-hidden-content-and-fenced-longer-than-any-backtick-run-inside-it.md) (park-comment marker trust)

## Context

Several factory comments are trusted only when the factory itself wrote them: the slice plan, park state, PR run state, decompose proposals, feedback-handled markers, and the factory's own reviews on stacked slice PRs. Each site read the factory's account with REST `GET /user` (`users.getAuthenticated`). GitHub refuses that endpoint for GitHub App installation tokens with 403 "Resource not accessible by integration". Under such a token, the slice plan lookup threw and stack-mode runs parked before creating a worktree. PR run state restored nothing, the decompose guard failed open, and the feedback round and stack approval reads failed.

## Decision

1. **One resolver.** `resolveSelfIdentity` in `packages/core/src/utils/github-identity.ts` returns `{ id, login, kind }`. It tries REST `GET /user` first, so personal and OAuth tokens behave as before.
2. **Narrow fallback.** Only when REST fails with HTTP 403 does it ask GraphQL `viewer`. It accepts the answer only when the viewer is a `Bot`. The login is normalized to `NAME[bot]`, the form REST comment authors carry, and `Bot.databaseId` becomes the id. A non-bot viewer, an empty login, or a client without GraphQL rethrows the original 403. Every other error (401, 5xx, network, GraphQL failure) is rethrown, so a real auth error never becomes "no identity".
3. **One ownership rule.** `isOwnComment(author, identity)` matches the author's REST id when the identity's id is known. Otherwise it requires the exact `[bot]` login and author type `Bot`. It never matches "any bot". Every own-comment check that read `GET /user` uses it.
4. **Caller semantics stay.** Each call site keeps its existing handling of genuine errors. The slice plan lookup throws, so the caller parks. PR run state treats a failed lookup as `identity-unavailable`. The decompose guard fails open with a warning.

This amends ADR-0174 decision 3: an installation token now reads its identity, so PR run state is restored. A genuine identity failure still fails closed.

## Consequences

- Stack mode, park comments, PR run state, decompose proposals, feedback rounds and stack approval work under a GitHub App installation token.
- Under such a token, each identity lookup costs one refused REST call plus one GraphQL call.
- A comment by another App's bot or by a human never passes as the factory's own, even with an identical marker.

## Alternatives considered

- **Treat any `[bot]` author as the factory.** Rejected: any installed App could forge factory state.
- **Fall back on every REST error.** Rejected: a bad or expired token would be misread as an App token.
- **Read the App slug from configuration.** Rejected: extra setup, and it can drift from the token actually in use.

## Amendment (2026-11-07)

Decision 2 as first written did not work for any token. It asked `query { viewer { __typename login ... on Bot { databaseId } } }`, but GitHub's schema types `viewer` as `User!`. A `... on Bot` spread inside `User` fails validation (`cannotSpreadFragment`), so GitHub rejected the query and the fallback always failed closed. Unit tests stubbed GraphQL responses, so nothing checked the document against the schema. The `__typename === 'Bot'` test was unsound for the same reason: the schema type of `viewer` is `User`.

Decision 2 now reads:

2. **Narrow fallback.** Only when REST fails with HTTP 403 does it ask GraphQL `query { viewer { login databaseId } }`, which uses only `User` fields. It accepts the answer only when the viewer is unmistakably a bot account with a numeric `databaseId`:
   - A login ending in `[bot]` is a bot account, because GitHub user logins cannot contain `[`. It is accepted as is, with `databaseId` as the id.
   - A login without the suffix is accepted only with positive evidence: REST `GET /users/{login}[bot]` must return type `Bot` with an id equal to `databaseId`. A 404 there rethrows the original 403. Any other error from that lookup is rethrown.
   - A missing or non-numeric `databaseId` rethrows the original 403. The resolver never returns an id-less identity, so own-comment checks never fall back to login matching on weaker evidence.

   A non-bot viewer, an empty login, or a client without GraphQL rethrows the original 403. Every other error is rethrown: 401, 5xx, network, and any GraphQL error, including a validation error.

Decision 3 is unchanged. `isOwnComment` matches by id when the id is known, otherwise by the exact `[bot]` login on a `Bot` author, and never matches "any bot".

Two checks guard this:

- **Schema regression.** `scripts/github-graphql-documents.test.ts` finds every `.graphql(` call in the shipped package sources and validates its document against GitHub's published public schema (`@octokit/graphql-schema`, pinned). A call whose document it cannot resolve fails the test. Fields GitHub added after the pinned snapshot are layered on verbatim from GitHub's public schema, and the overlay fails once the snapshot catches up.
- **Live installation token.** The CI `static` job runs `packages/core/src/utils/github-identity.live.test.ts` with the job's own `github.token`, which is a GitHub App installation token. The workflow's permissions are unchanged and the test only reads. It checks that REST `GET /user` is refused with 403, and that the resolver returns `github-actions[bot]` as a bot with the id REST reports for that account. The suite skips wherever `FACTORY_LIVE_GITHUB_TOKEN` is unset.

Under an installation token, each identity lookup costs one refused REST call and one GraphQL call. A suffix-less viewer login adds one REST user lookup.
