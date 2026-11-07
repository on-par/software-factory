# ADR-0176: The factory's own GitHub identity covers App installation tokens, and own-comment checks match that exact account

- Status: Accepted
- Date: 2026-11-06
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
