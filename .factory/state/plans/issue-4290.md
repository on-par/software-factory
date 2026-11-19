---
route: claude
design:
  restatedProblem: >-
    When a chained verify command (for example `format:check && lint &&
    typecheck && test`) fails only on the format, lint or typecheck step, the
    `tests` checker reports FAIL but `detectDeterministicGate` only recognises
    coverage threshold, test-time budget and LOC budget markers, so no
    `deterministicGate` is set. CHECK then calls `rerunTestsChecker`; with no
    failing test names `buildRerunPlan` falls back to a full suite re-run that
    cannot change the outcome and costs minutes before rework starts. The fix is
    to teach `detectDeterministicGate` three more gate kinds (format, lint,
    typecheck) while keeping the rule that any failing test name or failed test
    count means no gate, so a real flaky test is never hidden.
  approach:
    chosen: >-
      Extend the existing `GATE_MARKERS` table in deterministic-gate.ts with
      `format`, `lint` and `typecheck` entries (appended after the three
      existing kinds, so existing precedence is unchanged), widen
      `DeterministicGateKind` in types/index.ts, and add two optional per-marker
      fields: `when` (a regex that must match somewhere in the whole output
      before the marker counts, used to tie Prettier `[warn] <file>` lines to
      its summary and warning-only lint summaries to `--deny-warnings` /
      `--max-warnings 0`) and `ignore` (a regex for diagnostic lines removed
      from the test-failure scan only for that kind, so oxlint's `  ×
      eslint(rule): ...` diagnostics are not mistaken for vitest `×`
      failing-test markers). The CHECK skip branch in check.ts already logs
      `flaky re-run: skipped — deterministic gate failed (${kind})` generically
      and needs no change; `describeDeterministicGate` already lists the matched
      lines in rework details.
    rejected:
      - option: 'Add a separate detector function per tool, called from check.ts'
        reason: >-
          Duplicates the safety rule and the skip path; the marker table is the
          existing single owner.
      - option: >-
          Treat any `[warn]` line or any lint summary (including warnings-only)
          as a gate unconditionally
        reason: >-
          A passing lint step that printed warnings, or an unrelated `[warn]`
          line, would skip the re-run for a different failure (worse behaviour);
          the `when` guard prevents it.
      - option: >-
          Change `extractFailingTestNames` so `×` lines with `rule(...)` syntax
          are not test names
        reason: >-
          That function feeds baseline comparison and re-run targeting too;
          changing it is out of scope (buildRerunPlan targeting is a non-goal)
          and widens blast radius.
  interfacesTouched:
    - >-
      packages/core/src/types/index.ts — DeterministicGateKind gains 'format' |
      'lint' | 'typecheck'
    - >-
      packages/core/src/checkers/deterministic-gate.ts — GATE_MARKERS gains
      three entries plus optional when/ignore fields; detectDeterministicGate
      honours them
    - CHANGELOG.md — Unreleased entry
  targetTypes:
    - name: DeterministicGateKind
      file: packages/core/src/types/index.ts
      kind: changed
    - name: DeterministicGate
      file: packages/core/src/checkers/deterministic-gate.ts
      kind: read
    - name: CheckerOutput
      file: packages/core/src/types/index.ts
      kind: read
  signatures:
    - symbol: detectDeterministicGate
      file: packages/core/src/checkers/deterministic-gate.ts
      signature: >-
        export function detectDeterministicGate(output: string):
        DeterministicGate | null
    - symbol: describeDeterministicGate
      file: packages/core/src/checkers/deterministic-gate.ts
      signature: >-
        export function describeDeterministicGate(gate: DeterministicGate,
        uncovered: string[] | { unavailable: string }): string
  callGraph:
    - from: runFullTests
      to: detectDeterministicGate
      note: >-
        combined stdout+stderr of a failed, non-timed-out verify run; returns
        kind + matched lines
    - from: detectDeterministicGate
      to: extractFailingTestNames
      note: 'non-marker, non-ignored lines; any name means no gate'
    - from: detectDeterministicGate
      to: parseCommandCounts
      note: same rest text; failed > 0 means no gate
    - from: runFullTests
      to: describeDeterministicGate
      note: >-
        via gateDetails; non-coverage kinds get the matched lines only, appended
        to rework details
    - from: checkPhase
      to: rerunTestsChecker
      note: >-
        skipped when testsFail.deterministicGate is set; the skip log names the
        kind
  behaviorContract:
    - >-
      detectDeterministicGate returns { kind 'format', lines } when the output
      has a Prettier `Code style issues found` summary and no failing test;
      lines include the summary and the `[warn] <file>` lines.
    - >-
      detectDeterministicGate returns kind 'lint' for an oxlint `Found N
      warnings and M errors.` summary with M >= 1, an ESLint `✖ N problems (M
      errors, K warnings)` summary with M >= 1, ESLint `ESLint found too many
      warnings`, oxlint `Exceeded maximum number of warnings`, or a
      warnings-only oxlint summary when the output also shows `--deny-warnings`
      or `--max-warnings 0` / `--max-warnings=0`.
    - >-
      detectDeterministicGate returns kind 'typecheck' for `error TS<digits>:`
      lines.
    - >-
      oxlint `×`/`⚠` rule diagnostics no longer count as failing test names for
      the lint kind, so an oxlint failure is classified.
    - >-
      Any failing test name or failed test count outside the marker lines still
      returns null, so the flaky re-run runs exactly as before.
    - >-
      Existing kinds keep precedence (coverage threshold, test-time budget, loc
      budget are tried first) and their behaviour is unchanged.
    - >-
      CHECK logs `flaky re-run: skipped — deterministic gate failed
      (format|lint|typecheck)` and never calls the re-run for those kinds.
  verificationPlan:
    - command: >-
        npx vitest run packages/core/src/checkers/deterministic-gate.test.ts
        packages/core/src/phases/check.test.ts
        packages/core/src/checkers/tests-coverage-threshold.test.ts
      passWhen: 'all tests pass, including the new ones'
    - command: bash scripts/verify.sh --no-e2e
      passWhen: 'exits 0 (lint, typecheck, full tests, coverage ratchet green)'
  riskBlastRadius: >-
    A too-broad marker would set a gate on a run where a real test failed
    without a recognisable name or count, skipping the flaky re-run and sending
    a genuine flake to rework (costs a rework round, never a false PASS: the
    checker still FAILs). A too-narrow marker just keeps today's behaviour (full
    re-run). Only CHECK's re-run decision and rework details text are affected;
    no PASS/FAIL verdict changes.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        Format-only failure skips the re-run — detectDeterministicGate on
        passing vitest counts plus Prettier `[warn] src/a.ts` and `Code style
        issues found in 2 files` returns kind format with exactly those matched
        lines
      test: >-
        packages/core/src/checkers/deterministic-gate.test.ts "detects a
        format-only failure"
    - kind: fail-to-pass-test
      claim: >-
        Lint- or typecheck-only failure skips the re-run — oxlint `Found 0
        warnings and 3 errors.` with `× eslint(...)` diagnostics, ESLint `✖ 3
        problems (2 errors, 1 warning)`, and a warnings-only oxlint summary next
        to `> oxlint --deny-warnings` each return kind lint; `src/a.ts(3,5)
        error TS2322:` lines return kind typecheck
      test: >-
        packages/core/src/checkers/deterministic-gate.test.ts "detects lint and
        typecheck failures"
    - kind: fail-to-pass-test
      claim: >-
        A real test failure is never masked — Prettier summary plus ` × suite >
        adds` (and separately plus `Tests  1 failed | 10 passed (11)`) returns
        null; a warnings-only lint summary without a deny flag and a lone
        `[warn] x` line without the Prettier summary also return null
      test: >-
        packages/core/src/checkers/deterministic-gate.test.ts "a failing test
        keeps the re-run"
    - kind: fail-to-pass-test
      claim: >-
        The skip names the gate in the log and rework details — a checkPhase run
        whose tests FAIL carries the gate produced by detectDeterministicGate on
        Prettier output logs `flaky re-run: skipped — deterministic gate failed
        (format)`, never calls the re-run command, and the rework prompt
        contains the matched Prettier lines
      test: >-
        packages/core/src/phases/check.test.ts "format gate skips the flaky
        re-run"
    - kind: command
      claim: The CHANGELOG documents the behaviour change
      command: grep -n "deterministic gate" CHANGELOG.md
      passWhen: >-
        an entry under `## Unreleased` mentions format, lint and typecheck gates
        and
      expect:
        exitCode: 0
        stdoutContains:
          - '#4290'
  outline:
    - result: >-
        detectDeterministicGate classifies format, lint and typecheck failures
        and still returns null when a test failed
      files:
        - packages/core/src/types/index.ts
        - packages/core/src/checkers/deterministic-gate.ts
        - packages/core/src/checkers/deterministic-gate.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/checkers/deterministic-gate.test.ts
      manualChecks: []
    - result: CHECK skips the flaky re-run for a format gate and logs the gate name
      files:
        - packages/core/src/phases/check.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/core/src/phases/check.test.ts -t "format gate
          skips the flaky re-run"
      manualChecks:
        - >-
          Read a CHECK log for a format-only failure and confirm the skip line
          and matched lines in rework details
    - result: CHANGELOG Unreleased entry; full gate green
      files:
        - CHANGELOG.md
      automatedChecks:
        - bash scripts/verify.sh --no-e2e
      manualChecks: []
  edgeInputs:
    - empty output
    - output with only passing vitest counts and no marker
    - 'Prettier `[warn] <file>` lines with no `Code style issues` summary'
    - >-
      oxlint `Found 2 warnings and 0 errors.` with no deny/max-warnings flag in
      the output
    - oxlint `Found 0 warnings and 0 errors.`
    - 'ESLint `✖ 2 problems (0 errors, 2 warnings)`'
    - >-
      output that matches both a new marker and a vitest `×` failing test line
      or `Tests  N failed` count
    - output matching both an existing marker (coverage) and a new one (format)
    - timed-out run (never reaches the detector)
  behaviorDelta:
    - input: 'Prettier summary, all tests passed or not run'
      branch: 'format marker matches, rest has no failures'
      before: no gate; full flaky re-run
      after: gate format; re-run skipped; matched lines in rework details
      verdict: better
    - input: 'oxlint/ESLint error summary, no failing tests'
      branch: lint marker matches; oxlint diagnostics ignored for the test scan
      before: no gate; full flaky re-run
      after: gate lint; re-run skipped
      verdict: better
    - input: 'error TS<digits> lines, no failing tests'
      branch: typecheck marker matches
      before: no gate; full flaky re-run
      after: gate typecheck; re-run skipped
      verdict: better
    - input: new marker plus a failing test name or failed count
      branch: 'marker matches, rest has failures, returns null'
      before: no gate; re-run
      after: no gate; re-run
      verdict: same
    - input: >-
        [warn] lines without summary, or warnings-only lint summary without a
        deny flag, or zero-error summaries
      branch: 'when guard / pattern does not match, falls through'
      before: no gate; re-run
      after: no gate; re-run
      verdict: same
    - input: coverage threshold line plus format summary
      branch: existing coverage marker tried first
      before: gate coverage threshold
      after: gate coverage threshold
      verdict: same
    - input: empty output or output with no marker
      branch: no marker matches; loop ends and returns null
      before: no gate; flaky re-run runs as today
      after: no gate; flaky re-run runs as today
      verdict: same
  externalLists:
    - name: DeterministicGateKind union
      location: packages/core/src/types/index.ts DeterministicGateKind
      source: >-
        in-repo; every consumer (checkers/index.ts gateDetails, check.ts skip
        log) treats non-coverage kinds generically
      gaps: []
    - name: Prettier --check summary strings
      location: >-
        packages/core/src/checkers/deterministic-gate.ts GATE_MARKERS format
        entry
      source: >-
        Prettier CLI docs (--check prints `[warn] <file>` per file and `Code
        style issues found in N files` / `in the above file`)
      gaps: []
    - name: Linter summary strings
      location: packages/core/src/checkers/deterministic-gate.ts GATE_MARKERS lint entry
      source: >-
        oxlint CLI output (`Found N warnings and M errors.`, `--deny-warnings`,
        `--max-warnings`); ESLint stylish formatter (`✖ N problems (M errors, K
        warnings)`, `ESLint found too many warnings (maximum: N).`)
      gaps:
        - >-
          Non-default ESLint formatters (json, compact) and other linters
          (biome, ruff) are not recognised; they keep today's full re-run
    - name: TypeScript diagnostic format
      location: >-
        packages/core/src/checkers/deterministic-gate.ts GATE_MARKERS typecheck
        entry
      source: >-
        tsc output (`file(l,c): error TSnnnn:` and pretty `file:l:c - error
        TSnnnn:`)
      gaps: []
---
# Spec: CHECK skips the flaky re-run when only a format, lint or typecheck step failed (#4290)

## Goal

When a chained verify command fails only on a format, lint or typecheck step, CHECK should treat it as a
deterministic gate failure and go straight to rework. Today it spends a full test-suite re-run (about 6
minutes) that cannot pass. We reuse the existing deterministic-gate path from #4263 and keep its safety rule:
any failing test name or failed test count means no gate, so the flaky re-run still runs.

## Files / approach

1. `packages/core/src/types/index.ts`, line 124: widen the union to
   `'coverage threshold' | 'test-time budget' | 'loc budget' | 'format' | 'lint' | 'typecheck'`.

2. `packages/core/src/checkers/deterministic-gate.ts`:
   - Change the `GATE_MARKERS` element type to
     `{ kind: DeterministicGateKind; pattern: RegExp; when?: RegExp; ignore?: RegExp }`.
   - Keep the three existing entries first, in their current order. Then append:
     - `format`: `pattern: /Code style issues (?:were )?found\b|^\[warn\] \S/`,
       `when: /Code style issues (?:were )?found\b/`. A lone `[warn]` line without the summary never counts.
     - `lint`: `pattern:` an alternation of
       `^Found \d+ warnings? and [1-9]\d* errors?\b` (oxlint errors),
       `^✖ \d+ problems? \([1-9]\d* errors?, \d+ warnings?\)` (ESLint errors),
       `^ESLint found too many warnings\b`, and
       `^Exceeded maximum number of warnings\b`. Then add a **second** `lint` entry for the warnings-only
       deny case: `pattern: /^Found [1-9]\d* warnings? and 0 errors?\b/`,
       `when: /--deny-warnings\b|--max-warnings[= ]0\b/`. Both lint entries get
       `ignore: /^[×⚠!]\s+[\w@./-]+\([\w@./-]+\)/`. That drops oxlint diagnostics such as
       `× eslint(no-unused-vars): ...` and `× anti-slop(no-comments): ...` from the test-failure scan only.
       A matching vitest name is still caught by its `Tests  N failed` count.
     - `typecheck`: `pattern: /\berror TS\d+:/`.
   - In `detectDeterministicGate`, compute `const text = lines.join('\n')` once. For each marker:
     - skip it if `when` is set and `!when.test(text)`;
     - `matched` = lines matching `pattern`, then `continue` if there are none;
     - `rest` = lines that match no marker `pattern` and do not match this marker's `ignore`, as today;
     - the existing `extractFailingTestNames(rest)` / `parseCommandCounts(rest)?.failed` guard stays and
       returns null.

     Return `{ kind, lines: [...new Set(matched)].slice(0, MAX_GATE_LINES) }` as today. All patterns must be
     non-global, so `.test` keeps no `lastIndex` state. No comments (ADR-0177).
   - `describeDeterministicGate` and `gateDetails` in `checkers/index.ts` need no change. Non-coverage kinds
     already get `deterministic gate failed (<kind>); no test failed ... Fix the gap:` plus the matched lines.

3. `packages/core/src/phases/check.ts`: no change. Lines 420-422 already skip the re-run and log
   `flaky re-run: skipped — deterministic gate failed (${testsFail.deterministicGate})`.

4. `CHANGELOG.md`: under `## Unreleased`, add a `### Changed` bullet. It says CHECK now also skips the flaky
   re-run when the tests checker failed only on a format (Prettier `--check`), lint (oxlint/ESLint errors, or
   warnings under `--deny-warnings` / `--max-warnings 0`) or typecheck (`error TS<n>:`) step, with no failing
   test. It also says the skip logs `flaky re-run: skipped — deterministic gate failed (<gate>)` and the rework
   details list the matched lines (#4290).

## Tests

In `packages/core/src/checkers/deterministic-gate.test.ts`, add a `describe('detectDeterministicGate format, lint and typecheck (#4290)')` block:
- `"detects a format-only failure"`: `${PASSING_RUN}\n[warn] src/a.ts\n[warn] src/b.ts\n[warn] Code style issues found in 2 files. Run Prettier with --write to fix.`
  returns `{ kind: 'format', lines: [the three [warn] lines] }`. Also check the plain
  `Code style issues found in 2 files` line from the issue.
- `"detects lint and typecheck failures"`:
  - oxlint output (`  × eslint(no-unused-vars): Variable 'x' is declared but never used.` plus
    `Found 0 warnings and 3 errors.`) returns kind `lint`, and its lines contain the summary;
  - ESLint `✖ 3 problems (2 errors, 1 warning)` returns `lint`;
  - `> oxlint --deny-warnings\nFound 2 warnings and 0 errors.` returns `lint`;
  - `src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.` plus the pretty form
    `src/b.ts:1:1 - error TS2322: ...` returns `{ kind: 'typecheck', lines: [both] }`.
- `"a failing test keeps the re-run"`: these return `null`:
  - the format summary plus ` × suite > adds 3ms`;
  - the format summary plus `      Tests  1 failed | 10 passed (11)`;
  - `Found 2 warnings and 0 errors.` with no deny flag;
  - `Found 0 warnings and 0 errors.`;
  - `[warn] something` alone.
- Existing #4263 tests stay unchanged and green, which proves precedence. Add one assertion that
  `${COVERAGE_LINE}\nCode style issues found in 2 files` still returns kind `coverage threshold`.

In `packages/core/src/phases/check.test.ts`, next to the #4263 test near line 2674, add
`it('format gate skips the flaky re-run', ...)`. Copy the #4263 test's setup, with one change: build the
checker result from the real detector:
`const gate = detectDeterministicGate(PRETTIER_OUTPUT)`, then
`details = describeDeterministicGate(gate!, [])` (import from `../checkers/deterministic-gate.js`), and
`deterministicGate: gate?.kind`. Assert:
- `argvs` is `[]`;
- `result.flakeRerun` is undefined;
- `logs` contains `'flaky re-run: skipped — deterministic gate failed (format)'`;
- `stub.calls[0]?.prompt` contains `Code style issues found in 2 files`.

Before the change, `gate` is null, so the log assertion fails. After the change, it passes.

Commands:
- `npx vitest run packages/core/src/checkers/deterministic-gate.test.ts packages/core/src/phases/check.test.ts packages/core/src/checkers/tests-coverage-threshold.test.ts`
- `bash scripts/verify.sh --no-e2e` (full gate before commit, or focused commands under the BUILD handoff with CHECK running the full gate)

## Constitution compliance

- Builds and type-checks: the union widening is additive. `deterministicGate` consumers handle the new kinds
  generically, and `npm run typecheck` runs in verify.
- Tests: colocated tests are added in `deterministic-gate.test.ts` and `check.test.ts`. Existing #4263 tests are
  unchanged. No coverage threshold is lowered; if the ratchet reports a rise, raise it in the same PR.
- Lint clean: no comments (ADR-0177), `.js` relative imports, no new package boundaries crossed (all within core).
- Diff matches the issue: detector, type, tests and CHANGELOG only. Nothing changes in `buildRerunPlan`, the
  checker split or BUILD.
- No secrets, debug leftovers or disabled tests.
- Docs/changelog rule: a CHANGELOG Unreleased entry is added. No user doc currently describes deterministic
  gates, so no further docs change.
- ADRs: no conflict. ADR-0158 and ADR-0164 are untouched. The skip only affects the re-run, never the FAIL verdict.

## Non-goals

- Splitting the verify command into separate checkers.
- Changing `buildRerunPlan` targeting or `extractFailingTestNames`.
- Moving lint or typecheck earlier in BUILD.
- Recognising non-default lint formatters or other linters/formatters (biome, ruff, black).
