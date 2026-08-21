# ADR-0043: A tripped pre-flight size gate files sub-issues under the original issue and re-queues them; the post-plan gate still parks

- Status: Accepted
- Date: 2026-08-21

## Context

The readiness size gate trips at two different points in PLAN. The pre-flight gate fires before any
planning model call is spent, on evidence that lives entirely in the issue body. The post-plan gate
fires after a full PLAN model call, on the declared surface of the frozen design artifact.

Until now both resolved identically: run the advisory decomposition pass, post the proposed epic and
stories as a comment, park the lane. Parking killed the whole lane, and because .factory/queue was
never rewritten, every subsequent supervise cycle re-read the same entry, burned another decompose
call on the same issue, and parked again — an unbounded loop only a human could break, by filing the
sub-issues and hand-editing the queue.

Making the trip self-healing needs a decision about what the filed artifacts are. The decomposition
output is an epic plus child stories, so one option is to file the epic as a new issue and hang the
stories off it. But the original oversized issue already holds the epic's content, its comment
history, and whatever links point at it; filing a second epic leaves the original with no defined
role and turns a one-for-N queue replacement into a three-level reconciliation. It also has to be
decided whether the post-plan gate gets the same treatment, when a model call has already been spent
on a plan a human may want to read.

## Decision

A pre-flight size-gate trip files the proposed child stories as real GitHub issues and links each one
as a native sub-issue of the ORIGINAL oversized issue, via
POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues. The original issue is the parent of its
own decomposition; no separate epic issue is ever filed. The rendered epic remains a comment on the
parent, as the audit trail of what the decomposition proposed.

The oversized issue's .factory/queue entry is then replaced in place by one entry per child, on the
same lane and in build order, and the lane continues with those children instead of parking. Filing
is opt-in per call site: `decomposeOversizedIssue` files nothing unless its caller passes
`fileSubIssues: true`. Only the pre-flight gate passes it.

The post-plan build-scope gate keeps today's behavior exactly — comment, park, no filing, no queue
rewrite — because by then a planning model call has been spent and the plan itself is evidence a
human should read before the work is re-cut. Any failure to file (issue creation error, sub-issue
link error, unparseable model output, INVEST-gate rejection) degrades to that same park-and-comment
path with a logged reason; the lane never continues on a partially filed decomposition.

## Consequences

The common oversized-issue case now resolves without a human: sub-issues exist, are linked under the
parent on GitHub's native sub-issue UI, are queued, and the lane keeps working. The re-plan loop that
re-decomposed the same issue every supervise cycle is closed, because the queue entry is gone.

The cost is that a tripped pre-flight gate now writes to GitHub — a bad decomposition produces real
issues a human has to close, not just a comment they can ignore. That is bounded by the INVEST gate,
which must pass for every story before anything is filed, and by the fail-closed rule above.

Because the original issue is the parent, it stays open as an epic-shaped container rather than being
closed or re-templated; anything that assumes a queued issue is always a leaf task must account for
it. And the two gates now behave differently on the same underlying condition, which is deliberate:
the distinction is whether a planning model call has already been spent, and any future change to one
gate must state why the other should or should not follow.

## References

- [Issue #823 — decompose: file real linked sub-issues and rewrite queue on size-gate trip](https://github.com/on-par/software-factory/issues/823)
- [GitHub REST API — sub-issues](https://docs.github.com/en/rest/issues/sub-issues)
