# ADR-0107: Epic readiness recognizes a second house style via a hand-picked field-synonym table

- Status: Accepted
- Date: 2026-09-16

## Context

`scoreIssueReadiness` (`packages/core/src/readiness/index.ts`) scores an epic body against
three required fields — `Why`, `Children`, `Done when` — found as ATX (`#`/`##`) headings.
Issue #1504 found that several well-written epics (#1376-#1379 in this repo) score 0% under
that rule despite having complete content, because they were written in a different, equally
legitimate house style: a preamble paragraph (no heading at all) stating the "why", followed by
bare `Label:` lines — `Scope:`, `Success means:`, `Context:` — instead of `#`-headings. Other
epics (#1433, #1437) already use the ATX style and already score 100%. Both styles read as
complete, well-structured epics to a human; only one passed the checker.

The fix has two independent parts. First, `extractIssueSections` needs to recognize `Label:`-only
lines as section breaks, and capture whatever precedes the first heading (of either style) as a
`preamble` section, since the house style's "why" has no heading of its own. Second, once those
sections are gettable, the checker needs to know that `Scope` means the same thing as `Children`,
`Success means` means the same thing as `Done when`, and `preamble` means the same thing as `Why`
— a hand-picked mapping, not something derivable from the field names or heading text alone.

## Decision

`extractIssueSections` takes an opt-in `labelLineHeadings` option. When set, it additionally
matches lines of the form `^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,3}):[ \t]*$` (a short Title Case
phrase alone on its own line, ending in a colon) as a heading, and captures any content before
the first heading of either style under a `preamble` key. This is opt-in and applied only after
`detectTemplate` has already classified the body as `epic` from a first, label-line-blind pass —
so a factory-task or factory-bug body with an incidental `Note:`-style line is never misread as
introducing a new section; that heuristic only ever fires for a body already known to be an epic.

A new `EPIC_FIELD_SYNONYMS` table maps each of the three required epic fields to the house-style
label(s) that satisfy it: `Why` → `preamble`, `Children` → `scope`, `Done when` → `success means`.
`findSection` grows an optional third `synonyms` parameter: it looks up the field itself first
(exact heading match, then prefix match, as before) and only tries the synonyms, in order, if that
comes up empty — so an epic that happens to use both an ATX `## Why` heading and a stray
`Preamble:`-shaped line is scored on the real heading, not the synonym. `detectTemplate` also
grows an `Epic:` (colon-suffixed title) match alongside the existing `[EPIC]`-prefix match, since
the house-style epics use that title convention instead.

The synonym table is hand-picked and epic-specific — it is not a generic fuzzy-matching or
NLP-based field-name resolver, and factory-task/factory-bug required fields get no synonym table.
Extending it to a new house-style label is a deliberate, reviewed decision, not something a future
field rename should silently fall into.

## Consequences

Positive: both observed epic house styles score consistently under `factory ready`, closing the
inconsistency #1504 reported, without reformatting any live GitHub epic body (an external,
non-durable artifact) and without weakening detection for factory-task/factory-bug bodies, which
never opt into label-line headings.

Negative: the synonym table is a manually maintained list that will need a new entry (and a PR
touching this ADR or its successor) if a third epic house style emerges. That is an accepted,
bounded cost — the alternative, a heuristic field-name matcher, would risk false-positive section
matches on the highly variable prose of hand-written epic bodies.

## References

- [Issue #1504 — Epic-body template or readiness-checker fix so \[EPIC\]-labeled issues pass factory ready](https://github.com/on-par/software-factory/issues/1504)
