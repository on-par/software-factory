# ADR-0131: An auto-filed bug carries a capped excerpt and a host:path pointer to the local raw log, never the raw log

- Status: Accepted
- Date: 2026-10-01

## Context

Auto-filed bug evidence was unbounded. Large excerpts made issues too large to review, and pasting raw log content into a GitHub issue moves data off the originating machine to a third-party service. The bare local log path in the body did not say which machine held the log, so reviewers could not find it. ADR-0130 already governs sanitizing and fencing that evidence; size and log location were still undecided.

## Decision

`renderBugBody` in `packages/core/src/filing/index.ts` caps the evidence excerpt at `maxExcerptChars` and the whole body at `maxBodyChars`, with defaults defined once as `defaultEvidenceCaps` in `packages/config/src/defaults.ts` (2000 and 8000). The excerpt is shortened, never the surrounding structure, and the hidden fingerprint and count markers are appended after capping. When anything is cut, the body states so in a visible note outside the fence. Every filed body points to the full raw log as `host:path` (host defaults to `os.hostname()`). The factory never uploads, attaches or syncs raw logs; new filing paths must send only a capped excerpt plus the pointer.

## Consequences

Filed issues stay reviewable and raw logs stay on the machine that produced them. Dedup keeps working because markers survive truncation. The cost is that a reviewer on another machine cannot read the full log from the issue and must reach the named host. The caps are not yet repo-configurable; making them so later means adding keys to the filing config schema.

References: issue #1842.
