// src/__fixtures__/adrs.ts — ADR documents for parse/serialize/detection tests (#467).
//
// These are TypeScript template literals, not `.md` files, because `npm run format:check`
// runs Prettier over markdown and would normalize away the deliberate convention
// differences (MADR frontmatter, classic-Nygard, extra blank lines) that the detection
// tests exist to prove. Prettier does not touch template-literal contents.
//
// Every fixture is written in canonical blank-line form (one blank line after each
// heading, one blank line between blocks, single trailing newline) except NON_CANONICAL,
// which is deliberately irregular and used only by the idempotence test.

export const ACCEPTED_NYGARD = `# ADR-0001: Use fixture ADRs to test the kit

- Status: Accepted
- Date: 2026-07-16

## Context

Testing the ADR kit requires realistic documents covering each status and template
variant without depending on the repository's real ADRs, which will change over time.

## Decision

Author a small set of representative fixtures directly in this package's test suite.

## Consequences

Round-trip and detection tests can assert against fixed, stable input.

## References

- [Nygard template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr.github.io](https://adr.github.io/)
`;

export const SUPERSEDED_NYGARD = `# ADR-0001: Use fixture ADRs to test the kit

- Status: Superseded by ADR-0007
- Date: 2026-07-16

## Context

Testing the ADR kit requires realistic documents covering each status and template
variant without depending on the repository's real ADRs, which will change over time.

## Decision

Author a small set of representative fixtures directly in this package's test suite.

## Consequences

Round-trip and detection tests can assert against fixed, stable input.

## References

- [Nygard template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
- [adr.github.io](https://adr.github.io/)
`;

export const REJECTED_NYGARD = `# ADR-0001: Use fixture ADRs to test the kit

- Status: Rejected
- Date: 2026-07-16

## Context

Testing the ADR kit requires realistic documents covering each status and template
variant without depending on the repository's real ADRs, which will change over time.

## Decision

Author a small set of representative fixtures directly in this package's test suite.

## Consequences

Round-trip and detection tests can assert against fixed, stable input.
`;

export const CLASSIC_NYGARD = `# 1. Record architecture decisions

Date: 2026-07-16

## Status

Accepted

## Context

We need to record the architectural decisions made on this project.

## Decision

We will use Architecture Decision Records, as described by Michael Nygard.

## Consequences

See Michael Nygard's article, linked above.
`;

export const MADR = `---
status: accepted
date: 2026-07-16
---

# Use fixture-based testing for the ADR kit

## Context and Problem Statement

Testing the ADR kit requires realistic documents covering each convention without
depending on the repository's real ADRs.

## Decision Outcome

Chosen option: author fixtures directly in the package's test suite.

## Consequences

Round-trip and detection tests can assert against fixed, stable input.
`;

export const WITH_EXTRA_SECTION = `# ADR-0002: Add an extra section

- Status: Accepted
- Date: 2026-07-16

## Context

Some ADRs carry sections this kit does not know about.

## Decision

Preserve unknown sections verbatim via extraSections and sectionOrder.

## Alternatives Considered

Dropping unknown sections was rejected because it would lose information.

## Consequences

Round-tripping proves no information is lost.

## References

- [ADR kit issue](https://github.com/on-par/software-factory/issues/467)
`;

export const NON_CANONICAL = `# ADR-0003: Non canonical spacing


- Status: Accepted
- Date: 2026-07-16


## Context

Body with irregular spacing.


## Decision

Body.


## Consequences

Body.`;

export const CRLF_NYGARD = ACCEPTED_NYGARD.replace(/\n/g, '\r\n');
