# ADR-0022: CHECK probes the worktree once per round and checkers consume those facts

- Status: Accepted
- Date: 2026-08-14

## Context

The checker framework grew three parallel registries with three call
signatures, and every CHECK round re-read the same worktree state several
times: linksChecker and accessibilityChecker each ran a full recursive
findHtmlFiles walk and duplicated the identical placeholder-link-counting
expression; check.ts's detectLiveAppSignal and detectHeadedModeSignals each
re-read the Playwright config files and re-parsed package.json scripts,
called 1-3 times per run. packageJson leaked a tri-state
(undefined=not-loaded, null=absent) that the type could not express, and
runAllCheckers duplicated a fail-closed try/catch per registry world. The
CHECK phase also re-runs checkers on every rework round, and the worktree
changes between rounds, so a probe captured once for the whole phase would
serve stale facts to later rounds. We needed one shape for a checker, one
fail-closed path, and one place where the worktree is read per round —
without changing the fail-closed-on-crash / fail-closed-on-unknown-name
behavior that tests and constitutions already depend on.

## Decision

The CHECK phase probes the worktree exactly once per round via a single
probeWorktree(worktree) function that reads package.json, walks HTML files,
and reads the Playwright configs, returning a WorktreeProbe facts record.
checkPhase re-probes at the top of each rework round and attaches the probe
to the CheckerContext; runAllCheckers consumes an attached probe and probes
only when none is present (direct/public callers). linksChecker,
accessibilityChecker, detectLiveAppSignal, and detectHeadedModeSignals all
consume the probe facts rather than walking or re-parsing on their own, and
the placeholder-link count lives in a single countPlaceholderLinks helper.
The checkers are a single registry of Checker { name, run(CheckerRunCtx) }
objects with router and timeout bound once by runAllCheckers, which runs
every entry — built-in, design_smells, custom_* wrapper, unknown — through
one fail-closed try/catch.

## Consequences

Positive: adding a checker now means one registry entry in one shape; adding
a new worktree fact means extending the probe instead of sprinkling new
filesystem reads across checkers; the CHECK phase performs one recursive
walk and one package.json/Playwright read per round regardless of how many
checkers need the facts; a crashing checker always surfaces as the same
'checker crashed' FAIL. Negative: checkers that need a fact not yet in the
probe must extend WorktreeProbe (a slight coupling between the phase and
the checker framework); a checker calling the probe-less fallback path
outside runAllCheckers still pays its own read; the packageJson tri-state
is now explicit (absent vs unreadable-with-error) and must not be collapsed
to a single null because the fail-closed checker behavior depends on the
distinction.

## References

- [Issue](https://github.com/on-par/software-factory/issues/667)
