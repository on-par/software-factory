# ADR-0160: Stricter config validation warns for one release before it fails

- Status: Accepted
- Date: 2026-10-12

## Context

The pre-PLAN config preflight `lintFactoryConfig` (`packages/core/src/config/config-lint.ts`, called from `runIssue` in `packages/core/src/run/run-issue.ts` and from `configLintChecks` in `packages/cli/src/cli/doctor.ts`) made unknown or placeholder constitution checkers escalate (#2585) and unfilled template tokens park (#2586). Before that, the same config was silently ignored. It shipped as a hard failure with no prior warning, so repos that were green started failing mid-run after an upgrade (#2566). The factory runs unattended, so a surprise hard stop costs a whole lane until a human notices it.

## Decision

Stricter validation of user config ships in two stages.

- This applies to any new validation rule, or any tightening of an existing one, that would make config which passes today escalate, park, or fail. That covers preflight, doctor, config loaders and constitution parsing.
- **Release N (warn stage):** the rule detects the problem but never blocks. It must:
  - emit a structured warning event through the run's event log (ADR-0002), with the file, the line when known, and the fix, and
  - add a `factory doctor` row for the finding that is non-failing: `ok: false` with `optional: true`, so it renders as a warning, counts under warnings and not failures, and does not change doctor's exit code. The doctor row includes `file:line`, the fix, and says the rule becomes an error in the next release.
- **Release N+1 (fail stage):** the same rule becomes a hard failure. Preflight escalates or parks as the rule specifies, and the doctor row becomes a failing row (`ok: false`, not optional).
- A rule must not skip the warn stage. It moves to the fail stage only in a later release than the one that introduced the warning. The changelog or release notes for N name the rule as "warns now, fails next release".
- Exception: a rule that blocks a security or data-loss hazard may ship as a hard failure immediately. Its PR must state why, and it should still add the doctor row.
- Out of scope: this ADR does not auto-fix config. Doctor reports and never edits files. The rules already shipped (#2585, #2586) are not rolled back to a warn stage.

## Consequences

Users get one release to fix config that `factory doctor` can show them. Each stricter rule needs two PRs across two releases, and the warn-stage code must carry both behaviors or a stage marker. Doctor and preflight must keep sharing one rule set (`lintFactoryConfig`, #2612) so the warning and the later failure cannot drift apart. This matches ADR-0153, which also prefers a log-only default before any hard stop on unattended runs.

References: issue #2613, parent #2566, epic #2560, related #2585, #2586, #2612.
