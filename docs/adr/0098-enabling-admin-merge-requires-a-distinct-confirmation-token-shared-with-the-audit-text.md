# ADR-0098: Enabling admin-merge requires a distinct confirmation token, shared with the audit text

- Status: Accepted
- Date: 2026-09-12

## Context

ADR-0096 gave the app a generic allow-list write surface for repo policy
fields (`SAFE_POLICY_FIELDS`) and deliberately excluded `merge.admin`,
deferring it to this issue. `merge.admin` is not like `merge.auto`: it grants
GitHub admin bypass power over required-check gating, so enabling it from a
stray click or a routine bulk edit carries outsized risk, and there was no
distinct trace in the UI or daemon logs calling out that this specific bypass
had been turned on — both of which hamper after-the-fact audit of who
enabled it and when (issue #1390). Reusing the existing one-click
save-on-toggle flow for this field would not meet that bar.

`resolveMergePolicy` (`config/index.ts`) also only reads `run.merge.admin` —
the top-level `merge.admin` key the schema declares is never consulted for
the effective value. Writing the field at the same path shape as
`merge.auto` (top-level `merge.admin`) would silently no-op.

## Decision

`merge.admin`'s entry in `SAFE_POLICY_FIELDS` carries `configPath:
['run', 'merge', 'admin']` (the path `resolveMergePolicy` actually reads)
and a `confirmEnable: { token, auditText }` spec. `policyConfirmationFor(id,
value)` returns that spec only when `value` is an _enable_ — disabling, and
every other field (`merge.auto`), return `undefined` and keep today's
one-click save. `setSafeRepoPolicyField` refuses to touch disk — no
`mkdirSync`, no `writeFileSync` — unless its caller passes a
`confirmationToken` equal to the spec's `token`; `PUT
/repos/<owner>/<name>/policy` pre-checks the identical predicate and answers
400 `reason: 'confirmation-required'` with nothing written when the token is
missing or wrong, so the write is blocked at both the route and the writer.

`auditText` is a single string, read from the same `confirmEnable` spec by
three call sites: the writer's error when the token is missing, the
daemon's `AUDIT <repo>: <auditText>` log line emitted only on a successful
confirmed write, and the dashboard's `role="status"` banner shown after that
write succeeds. One string, one place it is authored, so the log line and
the UI copy cannot drift apart.

The confirmation token is a deliberate-action ceremony, not a credential —
it is a fixed, non-secret string returned to any caller by
`policyConfirmationFor`/the field spec itself. The loopback bind (ADR-0094)
remains the actual authorization boundary; the token exists to force a
second, distinct step before the bypass is armed, not to gate who may arm
it.

## Consequences

Positive: enabling admin-merge cannot happen as a side effect of a generic
settings save; every enable leaves an unambiguous, differently-worded audit
trail in both the daemon log and the UI; the fix for the `run.merge.admin`
read-path trap is encoded directly in the allow-list entry instead of
relying on a future contributor to remember it. Disabling and `merge.auto`
are intentionally exempt — the acceptance criteria for #1390 scope the
distinct-confirmation requirement to the enable path only.

Negative: `setSafeRepoPolicyField`'s fourth parameter is now an options
object (`{ env?, confirmationToken? }`) instead of a bare `env`, touching
every existing caller; a future confirmation-gated field must remember to
thread its token through the same two checkpoints (writer and route) or the
gate silently degrades to one of them.

References:

- Issue #1390 — App settings: admin-merge requires distinct confirmation
  and audit text
- ADR-0094 — The app explains an attach rejection from factoryd's reason
  code, never from its detail string (loopback-as-authorization posture)
- ADR-0096 — The app settings API writes only allow-listed safe policy
  fields
