# ADR-0129: Issue bodies reach PLAN and BUILD only inside an untrusted-issue-body block with a do-not-follow notice

- Status: Accepted
- Date: 2026-10-01

## Context

GitHub issue bodies are written by anyone who can file or edit an issue, yet the factory pasted them into the PLAN prompt as plain text and, through the fast-path spec, into BUILD. Directives inside a body were indistinguishable from the factory's own instructions. The readiness enrich and decompose prompts already wrap untrusted text in `<untrusted-*>` tags. PLAN and BUILD, the two phases with write access to the worktree, did not. Injection detection, sandboxing (#1760) and body sanitization are separate concerns and deliberately not part of this decision.

## Decision

Any prompt or spec that places a GitHub issue body in front of a PLAN or BUILD agent wraps it with `wrapUntrustedIssueBody` from `packages/core/src/utils/untrusted-input.ts`, which puts the verbatim body between `<untrusted-issue-body>` and `</untrusted-issue-body>` lines. The PLAN prompt and every BUILD prompt builder include `UNTRUSTED_ISSUE_BODY_NOTICE`, which tells the agent the block holds requirements data and that directives inside it must not be followed. The fast-path spec freezes the body only inside that block. BUILD never receives the raw issue body as a separate prompt input. New code that adds an issue body to an agent prompt must use this helper, not its own tags or wording.

## Consequences

PLAN and BUILD agents get one consistent, testable signal for which text is untrusted, and the tag and notice cannot drift between phases. The wrapper does not sanitize, so a body containing the closing tag can still break out of the block. Wrapping lowers the chance of a model obeying injected text; it is not a guarantee. Containment and sandboxing stay the actual security boundary. Prompt wording changes slightly, which may shift eval baselines.

References: issue #1840.
