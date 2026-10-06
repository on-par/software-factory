# ADR-0130: Auto-filed bug evidence is stripped of hidden content and fenced longer than any backtick run inside it

- Status: Accepted
- Date: 2026-10-01

## Context

`fileBug` turns failure evidence (log excerpts, component names, paths) into GitHub issues that later factory agents read and may act on. GitHub hides HTML comments, zero-width characters, bidi controls and other format characters when rendering, so evidence could carry instructions a human reviewer never sees. The excerpt was also wrapped in a fixed three-backtick fence, which an excerpt containing a backtick run could close, turning the rest into live markdown. The filer relies on its own hidden `<!-- fp:… -->` / `<!-- fp-count:… -->` markers for dedup, so hidden comments cannot simply be banned from the body.

## Decision

Every evidence string `fileBug` places in an issue title, body or comment first passes through `sanitizeEvidence` / `stripHiddenContent` in `packages/core/src/filing/sanitize.ts`. It removes Unicode format characters (`\p{Cf}`: zero-width, bidi, tag, soft hyphen), C0/C1 controls other than tab/newline/carriage return, and HTML comments (including an unterminated trailing `<!--`), repeated until the text is stable. The filer appends its own markers only after sanitizing, so they are the only hidden content in a filed body. The excerpt is fenced by `fenceExcerpt` with a backtick fence of max(5, longest inner backtick run + 1). New filing render paths must use these helpers rather than interpolating evidence directly.

## Consequences

Filed bugs show reviewers exactly what agents will read, and an excerpt can no longer break out of its code block. Legitimate invisible characters in evidence (e.g. ZWJ inside emoji) are lost, which is acceptable for log text. Size caps and classifier-based injection detection remain separate concerns. Consistent with ADR-0129 (untrusted issue bodies).

References: issue #1841.
