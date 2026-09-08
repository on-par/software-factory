# `design_artifact_invalid` root cause (Issue #1329)

Date: 2026-09-08

## Context

Issue #1329 asks why a `design_artifact_invalid` condition occurred during the
SB#1395 ship run, with no documented explanation. No literal "SB#1395" log
exists anywhere in this checkout — confirmed by `grep -r SB#1395` across the
repo and corroborated by sibling issue #1328's own research doc
(`docs/research/ship-phase-breakdown-1328.md:23`), which hit the same wall
independently. `.factory/events.ndjson` is a per-lane runtime file and is
never committed to git, so no historical event log survives past the run
that produced it.

In the absence of the specific SB#1395 log, this doc traces the condition
through the validation code path itself and grounds the trigger shapes in
two other sources of hard evidence that are on disk in this repo:
this repo's own committed eval trial logs, and an already-filed, already
root-caused GitHub issue for the same code path.

## The validation code path

1. PLAN writes a frozen spec whose YAML frontmatter may contain a `design:`
   block (prompt template at `packages/core/src/phases/plan.ts:57-176`).
2. `parseDesignArtifact()` (`packages/core/src/design/index.ts:14-26`) reads
   that frontmatter:
   ```ts
   export function parseDesignArtifact(frontmatter: unknown): { artifact: DesignArtifact | null; errors: string[] } {
     if (typeof frontmatter !== 'object' || frontmatter === null || !('design' in frontmatter)) {
       return { artifact: null, errors: ['no design block in spec frontmatter'] };
     }
     const result = DesignArtifactSchema.safeParse((frontmatter as { design: unknown }).design);
     if (!result.success) {
       const errors = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
       return { artifact: null, errors };
     }
     return { artifact: result.data, errors: [] };
   }
   ```
   It returns `artifact: null` in exactly two cases: no `design` key at all,
   or `DesignArtifactSchema.safeParse` (`packages/contracts/src/design.ts:39-62`)
   rejecting the block.
3. `planPhase()` calls it at `plan.ts:516`. When `artifact` is `null`, it logs
   `design_artifact_invalid` at `plan.ts:583` with the raw Zod error path
   joined into the message, and **continues** — the event is `severity: warn`,
   `isPark: false`, `isTerminal: false` (`packages/core/src/events/kinds.ts:212`).
   PLAN still returns `ok: true`; BUILD proceeds without design grounding.
   This is a deliberate soft-fail, not a bug in the control flow — the bug (see
   below) is in the fact that a single malformed array element discards
   `restatedProblem`, `approach`, and every other field along with it.

## Two confirmed trigger shapes

This repo's committed eval baseline (`evals/scbench-baseline/runs/cfgpipe/**/events.ndjson`)
has four real `design_artifact_invalid` occurrences, and they are exactly the
two shapes below — nothing else:

```
$ grep -h design_artifact_invalid evals/scbench-baseline/runs/cfgpipe/checkpoint_*/trial-*/events.ndjson
{"type":"design_artifact_invalid","issue":"9615602","msg":"spec frontmatter has no valid design artifact: behaviorContract.2: Invalid input: expected string, received object", ...}
{"type":"design_artifact_invalid","issue":"9899366","msg":"spec frontmatter has no valid design artifact: no design block in spec frontmatter", ...}
{"type":"design_artifact_invalid","issue":"9899366","msg":"spec frontmatter has no valid design artifact: no design block in spec frontmatter", ...}
{"type":"design_artifact_invalid","issue":"9615602","msg":"spec frontmatter has no valid design artifact: behaviorContract.2: Invalid input: expected string, received object", ...}
```

**Shape 1 — no `design:` block at all.** The boss model's response simply
omitted the frontmatter key. `parseDesignArtifact`'s first branch fires
(`'no design block in spec frontmatter'`). This is the "model didn't emit
one" case — not a schema defect, just a run with no design grounding to fall
back on.

**Shape 2 — an object-shaped element inside a flat string-array field.**
`behaviorContract.2: Invalid input: expected string, received object` means
the model emitted an object (e.g. `{ ... }`) as the third element of
`behaviorContract`, which the schema declares as
`z.array(z.string().min(1))` (`packages/contracts/src/design.ts:58`) — plain
strings only, no tolerance for a malformed element. `safeParse` fails the
_entire_ `DesignArtifactSchema`, not just that one field, so the whole
artifact — `restatedProblem`, `approach`, `interfacesTouched`,
`verificationPlan`, `riskBlastRadius`, everything — is discarded.

## Why the model emits an object where a string is expected

This exact failure mode is already a named, tested phenomenon in this
codebase: sim regression fixture `#551`
(`packages/core/src/sim/regressions.ts:49-56, 92-105`) reproduces it
deterministically for the sibling field `interfacesTouched`:

```ts
/** #551: the frozen PLAN spec, but with one object-shaped element in `interfacesTouched` —
 *  the shape a model emits when it mirrors the sibling object lists in the PLAN prompt. */
```

The mechanism is the PLAN prompt template itself
(`packages/core/src/phases/plan.ts:94-121`). It lists six sibling fields
under `design:`, and every one of `targetTypes`, `signatures`, and
`callGraph` is presented as a list of **objects with named keys**:

```yaml
targetTypes:
  - name: <...>
    file: <...>
    kind: added|changed|read
signatures:
  - symbol: <...>
    file: <...>
    signature: '<...>'
callGraph:
  - from: <...>
    to: <...>
    note: <...>
```

`interfacesTouched` and `behaviorContract`, immediately adjacent, are the
only two fields in that block that are meant to be flat string lists:

```yaml
  interfacesTouched:
    - <file / exported function / type added or changed>
  ...
  behaviorContract:
    - <what is true after this change that was not true before>
```

A model that pattern-matches the surrounding object-shaped siblings
reasonably emits `- file: ..., symbol: ...`-style objects for these two
fields as well — exactly the class of error GitHub issue #551 documents for
`interfacesTouched`, and exactly what the eval logs above show actually
occurring for `behaviorContract` too. `DesignArtifactSchema` already
anticipates a degenerate-but-recoverable shape for `targetTypes`,
`signatures`, and `callGraph` — each uses `.nullish().transform((v) => v ?? [])`
specifically so a missing or null list doesn't fail the whole parse
(`packages/contracts/src/design.ts:46-57`) — but `interfacesTouched` and
`behaviorContract` never got that same tolerance, nor an unambiguous prompt
shape.

## Conclusion

`design_artifact_invalid` is triggered by `parseDesignArtifact()`
(`packages/core/src/design/index.ts:14-26`) validating the PLAN spec's
`design:` frontmatter against `DesignArtifactSchema`
(`packages/contracts/src/design.ts:39-62`), called from
`planPhase()` at `packages/core/src/phases/plan.ts:516`, with the log call
itself at `plan.ts:583`. It is a deliberate, non-terminal, non-park soft-fail
(`packages/core/src/events/kinds.ts:212`) — PLAN proceeds and BUILD simply
runs without design grounding.

Two independent trigger shapes are evidenced in this repo's own committed
eval logs: (1) the model omits the `design:` block entirely (not a schema
defect), and (2) the model emits an object where `behaviorContract` (or, per
issue #551's original report, `interfacesTouched`) requires a plain string —
because both fields sit in the prompt template directly next to three
sibling fields that _are_ object lists, and the schema treats one malformed
element as grounds to discard the entire artifact rather than just that
field.

## Follow-up

A fix for shape 2 is not implemented here (out of scope per the issue). It
is already tracked: **GitHub issue #551**, "One object element in
`interfacesTouched` silently discards the whole design artifact," already
root-causes this exact mechanism for `interfacesTouched` and proposes the
fix (tolerate/coerce a malformed element instead of discarding the whole
artifact, per the same pattern already used for `targetTypes`/`signatures`/
`callGraph`; and disambiguate the prompt's flat-string-list fields from its
object-list fields). This investigation adds direct evidence — this repo's
own `evals/scbench-baseline` trial logs — that the identical failure shape
also occurs on `behaviorContract`, so the fix in #551 should cover both
fields, not just `interfacesTouched`. A comment was added to #551 linking
back to #1329 with this additional evidence rather than filing a duplicate
issue.
