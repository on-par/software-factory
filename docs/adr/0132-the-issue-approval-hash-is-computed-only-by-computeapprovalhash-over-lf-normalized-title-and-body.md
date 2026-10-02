# ADR-0132: The issue approval hash is the SHA-256 of the LF-normalized title, a newline, and the LF-normalized body, computed only by computeApprovalHash

- Status: Accepted
- Date: 2026-10-01

## Context

Intake (#1802) moves authority from the `factory:queued` label to an approval pinned to exact issue content. Two slices need the same digest: `factory approve --rewrite` (#1843) reports the hash of the body it just wrote, and the plain approve and claim verification (#1826/#1827) must recompute it later from GitHub's copy. If two call sites compute it differently, for example with CRLF vs LF or a different title/body join, every approval looks "content changed" and enforce mode refuses every issue. The order in which slices land is not fixed, so the format must be pinned before the second consumer exists.

## Decision

`computeApprovalHash({ title, body })` in `packages/core/src/queue/approval.ts` is the only function that computes an approval hash. It replaces every `\r\n` and lone `\r` with `\n` in both title and body, joins them as `title + "\n" + body` without trimming, and returns the lowercase hex SHA-256 of the UTF-8 bytes. Callers render it as `sha256:<hex>`. Any change to the input format is a new marker version (`factory-approval v2`), never an in-place edit.

## Consequences

Approve, rewrite and claim verification can never disagree on the format. Whitespace-only edits, including trailing spaces, count as content changes and need reapproval, which is the conservative choice. Changing the format later means a marker version bump and reapproving the queued issues.

References: issues #1802, #1843. Consistent with ADR-0129 and ADR-0130.
