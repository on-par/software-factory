# ADR-0129: An issue approval is a comment whose v1 marker pins the sha256 of the LF-normalized title and body

- Status: Accepted
- Date: 2026-10-01

## Context

Approving an issue used to mean only adding queue labels, which records neither the approver nor the content approved, so an author could edit the issue after approval and the edited text would run (#1802, #1826). A later slice will verify approvals at claim time, and shell tooling such as the auto-merge sweep may need to recompute the hash, so the pin format must be stable, attributable to a GitHub identity, readable without local state, and reproducible outside TypeScript.

## Decision

`factory approve <issues...> --lane <lane>` (and its alias `factory queue add`) posts one comment per issue containing the hidden marker `<!-- factory-approval v1 sha256:<hex> lane:<lane> -->`, where `<lane>` is the lane slug used in `factory:lane:<lane>` and `<hex>` is the full lowercase SHA-256 of the UTF-8 string `title + "\n" + body`, with CRLF and lone CR converted to LF in both and a missing body treated as empty. No other normalization (no trimming, no Unicode normalization) is applied. The comment also carries a visible line naming the approver and the first 12 hex characters. The comment is posted before the queue labels, and an issue whose comment fails is not labelled. `computeApprovalHash` and `approvalMarker` in `packages/core/src/queue/approval.ts` are the only producers of this format; any change to the framing or marker bumps the version (`v2`) rather than altering `v1`.

## Consequences

Any edit to the title or body, including whitespace, invalidates an approval, which is the intent but means trivial edits require re-approval. Attribution relies on GitHub's comment author, not key signing. `factory queue add` now writes a comment and needs comment permission. Verifiers can recompute the hash with `printf '%s\n%s' "$title" "$body" | shasum -a 256` after normalizing line endings.

References: issue #1826, parent issue #1802.
