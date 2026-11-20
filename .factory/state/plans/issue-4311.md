---
design:
  restatedProblem: >-
    shipWithCiRework (packages/core/src/run/ci-rework-loop.ts) counts CI rework
    rounds (CodeQL, non-CodeQL attributable checks and preview rework) only in a
    local rounds variable. Nothing durable records how many rounds a PR has
    used, so a fresh process cannot tell whether the budget
    (resolveMaxCiReworkRounds, default 2) is already spent. This slice records
    each round's count against the PR number in the local run state file
    (state/runs/issue-<key>.json, IssueRunState) before that round's push. It
    keeps the record when a later recorder rewrites the file, and adds a read
    helper that returns used and cap for a given PR. The in-process loop still
    decides with its own in-memory counter, so behaviour and the default cap do
    not change.
  approach:
    chosen: >-
      Extend the existing run-state channel. RunStateUpdate gets an optional
      ciRework field with prNumber and used. IssueRunState gets an optional
      ciReworkRounds map from PR number (string key) to rounds used.
      nextIssueRunState merges it, taking the max per PR and never dropping
      earlier PRs. Right before runCiReworkRound, the loop calls
      safeRecordRunState with status shipping and the new count. The CLI
      runStateRecorder merges ciReworkRounds from the file on disk into every
      write, so a fresh process's recorder does not wipe it. A new module
      run/ci-rework-state.ts holds mergeCiReworkRounds, ciReworkBudget and
      readCiReworkBudget.
    rejected:
      - option: >-
          Store the count in the PR run-state comment (PrRunState rounds,
          ADR-0174)
        reason: >-
          That needs GitHub calls on every round, and it only works when the PR
          recorder is on. The recorder is skipped for resume, local-only and
          no-PR runs. The issue asks for run state.
      - option: 'A separate JSON store file keyed by PR, like review-rework.json'
        reason: >-
          That adds a new config path, new CLI wiring and a new port. The
          run-state file and the recordRunState port already reach the loop.
      - option: Make the loop read its starting count from the durable record
        reason: >-
          That changes in-process rework behaviour, which the issue rules out of
          scope. Later parts of #4305 will do it.
  interfacesTouched:
    - >-
      packages/core/src/types/index.ts - IssueRunState gains optional
      ciReworkRounds
    - >-
      packages/core/src/run/state.ts - RunStateUpdate gains optional ciRework;
      nextIssueRunState merges it
    - >-
      packages/core/src/run/ci-rework-state.ts (new) - mergeCiReworkRounds,
      ciReworkBudget, readCiReworkBudget, CiReworkBudget
    - >-
      packages/core/src/run/ci-rework-loop.ts - shipWithCiRework records the
      round before runCiReworkRound
    - packages/core/src/internal.ts - exports the new helpers and type
    - >-
      packages/cli/src/cli/ship-run-state.ts - runStateRecorder keeps
      ciReworkRounds from disk
    - CHANGELOG.md - Unreleased entry
    - docs/ops/steer-events.md - note on the run file field ciReworkRounds
  targetTypes:
    - name: IssueRunState
      file: packages/core/src/types/index.ts
      kind: changed
    - name: RunStateUpdate
      file: packages/core/src/run/state.ts
      kind: changed
    - name: CiReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      kind: added
  signatures:
    - symbol: mergeCiReworkRounds
      file: packages/core/src/run/ci-rework-state.ts
      signature: >-
        export function mergeCiReworkRounds(...maps: (Readonly<Record<string,
        number>> | undefined)[]): Record<string, number> | undefined
    - symbol: ciReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      signature: >-
        export function ciReworkBudget(state: Pick<IssueRunState,
        'ciReworkRounds'> | null | undefined, prNumber: number, env?:
        NodeJS.ProcessEnv): CiReworkBudget
    - symbol: readCiReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      signature: >-
        export async function readCiReworkBudget(runsDir: string, key: WorkKey,
        prNumber: number, env?: NodeJS.ProcessEnv): Promise<CiReworkBudget>
    - symbol: nextIssueRunState
      file: packages/core/src/run/state.ts
      signature: >-
        export function nextIssueRunState(prev: IssueRunState | undefined, base:
        IssueRunStateBase, update: RunStateUpdate, now: string): IssueRunState
    - symbol: runStateRecorder
      file: packages/cli/src/cli/ship-run-state.ts
      signature: >-
        export function runStateRecorder(runsDir: string, base:
        IssueRunStateBase): (update: RunStateUpdate) => Promise<void>
  callGraph:
    - from: shipWithCiRework
      to: safeRecordRunState
      note: >-
        status shipping, branch, and ciRework with prNumber and used = rounds,
        before runCiReworkRound
    - from: runStateRecorder
      to: nextIssueRunState
      note: update.ciRework merged into the ciReworkRounds map
    - from: runStateRecorder
      to: mergeCiReworkRounds
      note: >-
        on-disk ciReworkRounds merged with the in-memory map before
        writeIssueRunState
    - from: nextIssueRunState
      to: mergeCiReworkRounds
      note: prev.ciReworkRounds plus the entry for prNumber
    - from: readCiReworkBudget
      to: readIssueRunState
      note: >-
        reads runStateFile(runsDir, key), then applies ciReworkBudget to the
        parsed record
    - from: ciReworkBudget
      to: resolveMaxCiReworkRounds
      note: 'the cap, default 2, with the FACTORY_MAX_CI_REWORK_ROUNDS override'
  behaviorContract:
    - >-
      Before each CI rework round re-ships (pushes), shipWithCiRework records
      prNumber and used through ports.recordRunState. This covers CodeQL,
      non-CodeQL and preview rounds.
    - >-
      The run file state/runs/issue-<key>.json holds ciReworkRounds keyed by PR
      number as a string. No PR value ever decreases, and entries for other PRs
      are kept.
    - >-
      A fresh recorder (new process, new startedAt) that writes the same issue
      file keeps the existing ciReworkRounds.
    - >-
      readCiReworkBudget(runsDir, key, prNumber) returns used and cap. used is 0
      when the file, the map or the PR entry is missing or malformed. cap comes
      from resolveMaxCiReworkRounds (default 2).
    - >-
      The in-process round counter, the budget checks, the log lines and the
      park messages are unchanged.
  verificationPlan:
    - command: >-
        npx vitest run packages/core/src/run/ci-rework-state.test.ts
        packages/core/src/run/state.test.ts
        packages/core/src/run/ci-rework-loop.test.ts
        packages/core/src/run/ci-rework.test.ts
        packages/cli/src/cli/ship-run-state.test.ts
      passWhen: 'all tests pass, including the new ones'
    - command: bash scripts/verify.sh --no-e2e
      passWhen: 'exits 0 (format, build, type-check, lint, knip, coverage, stub evals)'
  riskBlastRadius: >-
    The loop records through safeRecordRunState, which only logs
    run_state_failed on error, so a write failure cannot change a rework or park
    outcome. A wrong merge could drop or inflate ciReworkRounds. Nothing reads
    the field for decisions in this slice, so only the new helper's answer would
    be wrong. A wrong recorder merge could lose steers or other run-file fields.
    The existing steer-preservation test guards against that. Each round's extra
    recordRunState call also triggers one PR run-state comment save (ADR-0174),
    whose errors are already logged and non-fatal.
  openQuestions:
    - >-
      A failed durable write is logged as run_state_failed and the round still
      goes ahead, like every other run-state write. If a later part of #4305
      needs fail-closed (no push without a record), it should make that change.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        Each CI rework round writes its count before it pushes - recordRunState
        gets ciRework prNumber with used 1 before the first rework re-ship, and
        used 2 before the second
      test: >-
        packages/core/src/run/ci-rework-loop.test.ts "records each CI rework
        round count in run state before the rework re-ship"
    - kind: fail-to-pass-test
      claim: >-
        A fresh process reading the same run state sees the same count - a child
        node process reads used 1 from the file the first recorder wrote, and a
        fresh recorder later write keeps it
      test: >-
        packages/core/src/run/ci-rework-state.test.ts "a second process reads
        the count the first process wrote"
        packages/cli/src/cli/ship-run-state.test.ts "keeps CI rework rounds from
        the run file when a fresh recorder writes"
    - kind: fail-to-pass-test
      claim: >-
        Existing in-process rework behaviour and the default cap 2 are unchanged
        - the budget helper reports cap 2 by default with nothing recorded, and
        the loop still parks exhausted after 2 rounds
      test: >-
        packages/core/src/run/ci-rework-state.test.ts "returns zero used and the
        default cap 2 when no round is recorded"
        packages/core/src/run/ci-rework-loop.test.ts "a non-CodeQL failure still
        red after the budget parks ci-failed as exhausted after 2 rounds"
    - kind: fail-to-pass-test
      claim: >-
        The read helper reports both rounds used and the cap for a given PR -
        readCiReworkBudget returns the PR own count, ignores other PRs, and
        honours FACTORY_MAX_CI_REWORK_ROUNDS
      test: >-
        packages/core/src/run/ci-rework-state.test.ts "returns the rounds
        recorded for the PR and ignores other PRs" "honours
        FACTORY_MAX_CI_REWORK_ROUNDS for the cap"
  outline:
    - result: >-
        IssueRunState and RunStateUpdate carry CI rework rounds per PR, and
        nextIssueRunState merges them by max per PR
      files:
        - packages/core/src/types/index.ts
        - packages/core/src/run/ci-rework-state.ts
        - packages/core/src/run/ci-rework-state.test.ts
        - packages/core/src/run/state.ts
        - packages/core/src/run/state.test.ts
        - packages/core/src/internal.ts
      automatedChecks:
        - >-
          npx vitest run packages/core/src/run/ci-rework-state.test.ts
          packages/core/src/run/state.test.ts
      manualChecks: []
    - result: >-
        shipWithCiRework records each round count before that round rework and
        re-ship
      files:
        - packages/core/src/run/ci-rework-loop.ts
        - packages/core/src/run/ci-rework-loop.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/core/src/run/ci-rework-loop.test.ts
          packages/core/src/run/ci-rework.test.ts
      manualChecks: []
    - result: >-
        the CLI recorder keeps ciReworkRounds across a fresh recorder writes;
        docs and changelog updated
      files:
        - packages/cli/src/cli/ship-run-state.ts
        - packages/cli/src/cli/ship-run-state.test.ts
        - CHANGELOG.md
        - docs/ops/steer-events.md
      automatedChecks:
        - npx vitest run packages/cli/src/cli/ship-run-state.test.ts
        - bash scripts/verify.sh --no-e2e
      manualChecks:
        - >-
          After a CI rework round, state/runs/issue-<n>.json shows
          ciReworkRounds with the PR number and count
---
---
route: codex
design:
  restatedProblem: >-
    `shipWithCiRework` (packages/core/src/run/ci-rework-loop.ts) counts CI rework rounds (CodeQL,
    non-CodeQL attributable checks and preview rework) in a local `rounds` variable only. Nothing
    durable records how many rounds a PR has used, so a fresh process (restart, another lane run,
    later parts of #4305) cannot tell whether the budget (`resolveMaxCiReworkRounds`, default 2)
    is already spent. This slice records each round's count against the PR number in the local
    run state file (`state/runs/issue-<key>.json`, `IssueRunState`) before that round's push,
    keeps the record when a later recorder rewrites the file, and adds a read helper that returns
    `{ used, cap }` for a given PR. The in-process loop keeps deciding on its own in-memory counter,
    so behaviour and the default cap stay the same.
  approach:
    chosen: >-
      Extend the existing run-state channel. `RunStateUpdate` gets an optional
      `ciRework: { prNumber, used }`. `IssueRunState` gets an optional `ciReworkRounds` map from
      PR number (string key) to rounds used. `nextIssueRunState` merges it, taking the max per PR
      and never dropping earlier PRs. The loop calls `safeRecordRunState(ports.recordRunState, ...)`
      with `status: 'shipping'` and the new count right before `runCiReworkRound` (which runs the
      worker and re-ships, so the push comes later). The CLI `runStateRecorder` merges
      `ciReworkRounds` from the file on disk into every write, for any `startedAt`, so a fresh
      process's recorder does not wipe it. A new module `run/ci-rework-state.ts` holds the merge
      and read helpers (`mergeCiReworkRounds`, `ciReworkBudget`, `readCiReworkBudget`).
    rejected:
      - option: Store the count in the PR run-state comment (`PrRunState.rounds` kind 'ci', ADR-0174)
        reason: >-
          That needs GitHub calls on every round and only works when the PR recorder is on (it is
          skipped for resume, local-only and --no-pr). The issue asks for run state. The PR comment
          can be built from the local record in a later part.
      - option: A separate JSON store file keyed by PR (like review-rework.json)
        reason: >-
          That would add a new path to the config paths, CLI wiring and a new port. The run-state
          file and the `recordRunState` port already reach the loop.
      - option: Make the loop read its starting count from the durable record
        reason: >-
          That changes in-process rework behaviour, which the issue rules out of scope. Later
          parts of #4305 will do it.
  interfacesTouched:
    - packages/core/src/types/index.ts — IssueRunState gains optional ciReworkRounds
    - packages/core/src/run/state.ts — RunStateUpdate gains optional ciRework; nextIssueRunState merges it
    - packages/core/src/run/ci-rework-state.ts (new) — mergeCiReworkRounds, ciReworkBudget, readCiReworkBudget, CiReworkBudget
    - packages/core/src/run/ci-rework-loop.ts — shipWithCiRework records the round before runCiReworkRound
    - packages/core/src/internal.ts — export the new helpers and type
    - packages/cli/src/cli/ship-run-state.ts — runStateRecorder keeps ciReworkRounds from disk
    - CHANGELOG.md — Unreleased entry
    - docs/ops/steer-events.md — note on the run file's new ciReworkRounds field (or the ops doc that describes state/runs)
  targetTypes:
    - name: IssueRunState
      file: packages/core/src/types/index.ts
      kind: changed
    - name: RunStateUpdate
      file: packages/core/src/run/state.ts
      kind: changed
    - name: CiReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      kind: added
  signatures:
    - symbol: mergeCiReworkRounds
      file: packages/core/src/run/ci-rework-state.ts
      signature: 'export function mergeCiReworkRounds(...maps: (Readonly<Record<string, number>> | undefined)[]): Record<string, number> | undefined'
    - symbol: ciReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      signature: 'export function ciReworkBudget(state: Pick<IssueRunState, ''ciReworkRounds''> | null | undefined, prNumber: number, env?: NodeJS.ProcessEnv): CiReworkBudget'
    - symbol: readCiReworkBudget
      file: packages/core/src/run/ci-rework-state.ts
      signature: 'export async function readCiReworkBudget(runsDir: string, key: WorkKey, prNumber: number, env?: NodeJS.ProcessEnv): Promise<CiReworkBudget>'
    - symbol: nextIssueRunState
      file: packages/core/src/run/state.ts
      signature: 'export function nextIssueRunState(prev: IssueRunState | undefined, base: IssueRunStateBase, update: RunStateUpdate, now: string): IssueRunState'
    - symbol: runStateRecorder
      file: packages/cli/src/cli/ship-run-state.ts
      signature: 'export function runStateRecorder(runsDir: string, base: IssueRunStateBase): (update: RunStateUpdate) => Promise<void>'
  callGraph:
    - from: shipWithCiRework
      to: safeRecordRunState
      note: '{ status: ''shipping'', branch, ciRework: { prNumber: plan.reentry.prNumber, used: rounds } } before runCiReworkRound'
    - from: runStateRecorder
      to: nextIssueRunState
      note: update.ciRework merged into the ciReworkRounds map
    - from: runStateRecorder
      to: mergeCiReworkRounds
      note: on-disk ciReworkRounds merged with the in-memory map before writeIssueRunState
    - from: nextIssueRunState
      to: mergeCiReworkRounds
      note: prev.ciReworkRounds plus { [prNumber]: used }
    - from: readCiReworkBudget
      to: readIssueRunState
      note: runStateFile(runsDir, key), then ciReworkBudget on the parsed record
    - from: ciReworkBudget
      to: resolveMaxCiReworkRounds
      note: the cap (default MAX_CI_REWORK_ROUNDS = 2, FACTORY_MAX_CI_REWORK_ROUNDS override)
  behaviorContract:
    - Before each CI rework round's worker runs and re-ships (push), shipWithCiRework records { prNumber, used } through ports.recordRunState. This covers CodeQL, non-CodeQL and preview rounds.
    - The run file `state/runs/issue-<key>.json` holds `ciReworkRounds` keyed by PR number as a string. Each PR's value never decreases, and other PRs' entries stay.
    - A fresh recorder (new process, new startedAt) writing the same issue file keeps the existing ciReworkRounds.
    - readCiReworkBudget(runsDir, key, prNumber) returns { used, cap }. used is 0 when the file, the map or the PR entry is missing or malformed. cap comes from resolveMaxCiReworkRounds (default 2).
    - The in-process round counter, the budget checks, the log lines and the park messages are unchanged.
  verificationPlan:
    - command: npx vitest run packages/core/src/run/ci-rework-state.test.ts packages/core/src/run/state.test.ts packages/core/src/run/ci-rework-loop.test.ts packages/core/src/run/ci-rework.test.ts packages/cli/src/cli/ship-run-state.test.ts
      passWhen: all tests pass, including the new ones
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (format, build, type-check, lint incl. no-comments and package boundaries, knip, coverage)
  riskBlastRadius: >-
    The loop's record call goes through safeRecordRunState, which only logs `run_state_failed` on
    error, so a write failure cannot change rework or park outcomes. If the merge is wrong,
    ciReworkRounds could be dropped or inflated. Nothing reads it for decisions in this slice, so
    only the new helper's answer would be wrong. If the recorder merge is wrong, steers or other
    fields in the run file could be lost. The existing steer-preservation test guards that. An
    extra recordRunState call during SHIP also triggers the PR run-state recorder save (ADR-0174)
    once per round. Its errors are already logged and not fatal.
  openQuestions:
    - A failed durable write is logged (`run_state_failed`) and the round still proceeds, like every other run-state write. If a later part needs fail-closed (no push without a record), it should change this then.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: Each CI rework round writes its count before it pushes — recordRunState is called with ciRework { prNumber, used 1 } before the re-ship shipPhase call, and with used 2 before the second re-ship
      test: packages/core/src/run/ci-rework-loop.test.ts "records each CI rework round count in run state before the rework re-ship"
    - kind: fail-to-pass-test
      claim: A fresh process reading the same run state sees the same count — after one recorder writes rounds for PR 7, a module-reset import and a child node process both read used 1 from the file, and a fresh recorder's later write keeps it
      test: packages/core/src/run/ci-rework-state.test.ts "a second process reads the count the first process wrote" packages/cli/src/cli/ship-run-state.test.ts "keeps CI rework rounds from the run file when a fresh recorder writes"
    - kind: fail-to-pass-test
      claim: Existing in-process rework behaviour and the default cap (2) are unchanged — the budget helper reports cap 2 by default, and the loop still parks as exhausted after 2 rounds (existing test) while now recording used 2
      test: packages/core/src/run/ci-rework-state.test.ts "returns zero used and the default cap 2 when no round is recorded" packages/core/src/run/ci-rework-loop.test.ts "a non-CodeQL failure still red after the budget parks ci-failed as exhausted after 2 rounds"
    - kind: fail-to-pass-test
      claim: The read helper reports both rounds used and the cap for a given PR — readCiReworkBudget returns the PR's own count, ignores other PRs, and honours FACTORY_MAX_CI_REWORK_ROUNDS
      test: packages/core/src/run/ci-rework-state.test.ts "returns the rounds recorded for the PR and ignores other PRs" "honours FACTORY_MAX_CI_REWORK_ROUNDS for the cap"
  outline:
    - result: IssueRunState and RunStateUpdate carry CI rework rounds per PR, and nextIssueRunState merges them by max per PR
      files:
        - packages/core/src/types/index.ts
        - packages/core/src/run/ci-rework-state.ts
        - packages/core/src/run/ci-rework-state.test.ts
        - packages/core/src/run/state.ts
        - packages/core/src/run/state.test.ts
        - packages/core/src/internal.ts
      automatedChecks:
        - npx vitest run packages/core/src/run/ci-rework-state.test.ts packages/core/src/run/state.test.ts
      manualChecks: []
    - result: shipWithCiRework records each round's count before the round's rework and re-ship
      files:
        - packages/core/src/run/ci-rework-loop.ts
        - packages/core/src/run/ci-rework-loop.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/run/ci-rework-loop.test.ts packages/core/src/run/ci-rework.test.ts
      manualChecks: []
    - result: the CLI recorder keeps ciReworkRounds across a fresh recorder's writes; docs and changelog updated
      files:
        - packages/cli/src/cli/ship-run-state.ts
        - packages/cli/src/cli/ship-run-state.test.ts
        - CHANGELOG.md
        - docs/ops/steer-events.md
      automatedChecks:
        - npx vitest run packages/cli/src/cli/ship-run-state.test.ts
        - bash scripts/verify.sh --no-e2e
      manualChecks:
        - After a CI rework round, `cat state/runs/issue-<n>.json` shows "ciReworkRounds" with the PR number and count
---
# Spec: Record CI rework rounds in run state so a fresh process can read them (#4311)

## Goal

CI rework rounds are counted only in `shipWithCiRework`'s local `rounds` variable, so a restarted
or separate process cannot tell how much of a PR's CI rework budget is already used. This slice
records each round's count against the PR in the local run state file, before the round's push,
and keeps that record when the file is rewritten. It also adds a read helper that returns
`{ used, cap }` for a PR. This is part 1 of 3 split from #4305. Nothing reads the record for
decisions yet: the in-process loop and the default cap of 2 are unchanged.

## Files / approach

### 1. `packages/core/src/types/index.ts`
Add one optional field to `IssueRunState`, after `steers`:
```ts
ciReworkRounds?: Readonly<Record<string, number>>;
```
The key is the PR number as a decimal string and the value is the CI rework rounds used for that
PR. Add no comment (anti-slop/no-comments).

### 2. `packages/core/src/run/ci-rework-state.ts` (new)
```ts
import { readIssueRunState, runStateFile } from './state.js';
import { resolveMaxCiReworkRounds } from './ci-rework.js';
import type { IssueRunState } from '../types/index.js';
import type { WorkKey } from '../work/work-key.js';

export interface CiReworkBudget { used: number; cap: number }

export function mergeCiReworkRounds(...maps): Record<string, number> | undefined
export function ciReworkBudget(state, prNumber, env = process.env): CiReworkBudget
export async function readCiReworkBudget(runsDir, key, prNumber, env = process.env): Promise<CiReworkBudget>
```
- `mergeCiReworkRounds`: skip `undefined` or non-object inputs, and arrays. For each entry, keep
  only keys matching `/^\d+$/` with a value that is a non-negative safe integer. Per key, keep the
  max across inputs. Return `undefined` when no entry survives, otherwise a plain object.
- `ciReworkBudget`: `used = mergeCiReworkRounds(state?.ciReworkRounds)?.[String(prNumber)] ?? 0`,
  `cap = resolveMaxCiReworkRounds(env)`.
- `readCiReworkBudget`: `ciReworkBudget(await readIssueRunState(runStateFile(runsDir, key)), prNumber, env)`.
  `readIssueRunState` already returns `null` for a missing file or bad JSON, which gives `used: 0`.
- Watch for import cycles. `state.ts` will import `mergeCiReworkRounds` from this file, and this
  file imports `readIssueRunState` from `state.ts`. ESM cycles of functions-only modules are fine,
  but the cleanest layout avoids the cycle: put `mergeCiReworkRounds` in this file with no import
  from `state.ts` at module top, or put the two read helpers in this file and have `state.ts`
  import only `mergeCiReworkRounds`. Either way works if the build and the knip/lint gates are
  green. Do not hard-code the cap: always use `resolveMaxCiReworkRounds`.

### 3. `packages/core/src/run/state.ts`
- `RunStateUpdate` gets `ciRework?: { prNumber: number; used: number };`.
- In `nextIssueRunState`, compute
  `const ciReworkRounds = mergeCiReworkRounds(prev?.ciReworkRounds, update.ciRework ? { [String(update.ciRework.prNumber)]: update.ciRework.used } : undefined);`
  and add `...(ciReworkRounds === undefined ? {} : { ciReworkRounds })` to the returned object.
  The existing `remoteBranch` and `steers` carries stay unchanged.

### 4. `packages/core/src/run/ci-rework-loop.ts`
- Import `safeRecordRunState` from `./run-state-record.js`.
- In `shipWithCiRework`, immediately before `const step = await runCiReworkRound(roundPorts, plan);`, add:
  ```ts
  await safeRecordRunState(ports.recordRunState, log, {
    status: 'shipping',
    branch: request.branch,
    ciRework: { prNumber: plan.reentry.prNumber, used: plan.round },
  });
  ```
  `log` is the existing `ports.events()` logger. `plan.round` equals `rounds` in both the preview
  and the CI branch. `runCiReworkRound` runs the rework worker and then `reship` (the push), so
  this write always happens before the push. Do not change the `rounds` counter, `maxRounds`, the
  break conditions, the log messages or the park messages.

### 5. `packages/core/src/internal.ts`
Export `mergeCiReworkRounds`, `ciReworkBudget`, `readCiReworkBudget` and `type CiReworkBudget` from
`./run/ci-rework-state.js`, next to the `./run/state.js` export block. The CLI needs
`mergeCiReworkRounds`. Export `readCiReworkBudget` and `ciReworkBudget` for parts 2 and 3. If knip
flags an export with no consumer, keep only what knip accepts (`internal.ts` exports are normally
public surface), and keep `readCiReworkBudget` exported at least from `internal.ts`.

### 6. `packages/cli/src/cli/ship-run-state.ts`
In `runStateRecorder`, after reading `onDisk`, merge the on-disk rounds whatever the `startedAt`:
```ts
const ciReworkRounds = mergeCiReworkRounds(onDisk?.ciReworkRounds, current.ciReworkRounds);
if (ciReworkRounds !== undefined) current = { ...current, ciReworkRounds };
```
Do this outside the existing steers condition, which stays as it is. Import `mergeCiReworkRounds`
from `@on-par/factory-core/internal`. The existing comment lines in this file are baseline: do
not add new ones.

### 7. Docs and changelog
- `CHANGELOG.md` `## Unreleased` → `### Added`: `- The run file \`state/runs/issue-<n>.json\` records CI rework rounds per PR (\`ciReworkRounds\`) before each rework push, so a fresh process can read rounds used and the cap (#4311)`.
- Add a short paragraph to the ops doc that describes the run file (`docs/ops/steer-events.md`
  covers `state/runs/issue-<n>.json`). Name the `ciReworkRounds` field, its key (PR number), that
  each value only grows, and the cap source (`FACTORY_MAX_CI_REWORK_ROUNDS`, default 2).

## Tests

- `packages/core/src/run/ci-rework-state.test.ts` (new). Use a tmp dir per test (`mkdtemp`) and
  write with `writeIssueRunState` / `nextIssueRunState`.
  - "returns zero used and the default cap 2 when no round is recorded": missing file, and a file
    without the field, give `{ used: 0, cap: 2 }` with `env = {}`.
  - "returns the rounds recorded for the PR and ignores other PRs": map `{ '7': 2, '9': 1 }`. PR 7
    gives used 2, PR 9 gives used 1, PR 8 gives used 0.
  - "honours FACTORY_MAX_CI_REWORK_ROUNDS for the cap": `env = { FACTORY_MAX_CI_REWORK_ROUNDS: '4' }` gives cap 4.
  - "treats a malformed ciReworkRounds value as zero": the raw JSON file has
    `ciReworkRounds: { '7': -1, x: 3 }` or `ciReworkRounds: 'bad'`. Both give used 0.
  - "a second process reads the count the first process wrote": write rounds `{ '7': 1 }`. Then
    (a) `vi.resetModules()`, dynamically import `./ci-rework-state.js` and assert
    `readCiReworkBudget` gives `{ used: 1, cap: 2 }`, and (b) run
    `execFileSync(process.execPath, ['-e', <script reading the file with fs and printing ciReworkRounds['7']>, file])`
    and assert the output is `1`. Pass the file path as an argv entry, not interpolated into the
    script.
  - Unit tests for `mergeCiReworkRounds`: max per key, `undefined` when empty.
- `packages/core/src/run/state.test.ts`: add "nextIssueRunState records ciRework rounds keyed by
  PR and carries them across updates". An update with `ciRework {prNumber:7, used:1}`, then
  `{prNumber:7, used:2}`, then a plain status update, then `{prNumber:9, used:1}` ends with
  `{ '7': 2, '9': 1 }`. A lower `used` never lowers an entry.
- `packages/core/src/run/ci-rework-loop.test.ts`: in the `#3537` describe, add "records each CI
  rework round count in run state before the rework re-ship". Reuse the setup of "a non-CodeQL
  failure still red after the budget parks ci-failed as exhausted after 2 rounds" and pass a
  `recordRunState` `vi.fn()`. Assert calls with `ciRework: { prNumber: <pr>, used: 1 }` and
  `used: 2`. Assert each record call's `mock.invocationCallOrder` is lower than the matching
  re-ship `shipPhase` call (2nd and 3rd shipPhase invocations). Also extend the existing exhausted
  test, or the new one, to show the outcome and message are unchanged.
- `packages/cli/src/cli/ship-run-state.test.ts`: add "keeps CI rework rounds from the run file
  when a fresh recorder writes". Recorder A (startedAt t1) writes `{status:'shipping', ciRework:{prNumber:7, used:1}}`.
  Recorder B (new instance, startedAt t2) writes `{status:'planning'}`. The file still has
  `ciReworkRounds: { '7': 1 }`, and `readCiReworkBudget` gives `{ used: 1, cap: 2 }`. The existing
  steer test must still pass.
- Commands:
  `npx vitest run packages/core/src/run/ci-rework-state.test.ts packages/core/src/run/state.test.ts packages/core/src/run/ci-rework-loop.test.ts packages/core/src/run/ci-rework.test.ts packages/cli/src/cli/ship-run-state.test.ts`
  (BUILD focused handoff). CHECK runs `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- **Verify gate:** BUILD runs the focused vitest command above and reports it, and CHECK runs the
  full `bash scripts/verify.sh --no-e2e`. No coverage threshold is lowered. If the ratchet reports
  a rise, raise the threshold in `vitest.config.ts`.
- **No new comments:** the new code has no comments, and `comments-baseline.json` does not grow.
- **Tests:** every changed source file gets its colocated test updated. The new module gets a new
  colocated test. The new tests fail without the change: the field is absent, no record call is
  made, and the recorder drops the field. No test is skipped or deleted.
- **Architecture:** config ← core ← cli is respected. The CLI imports from
  `@on-par/factory-core/internal`, a published name on the ADR-0004 subpath. Relative imports use
  `.js`. No model ids are touched. The cap reuses `resolveMaxCiReworkRounds`, so the default 2
  stays in one place. Domain term: "rework round".
- **ADRs:** ADR-0162 (bounded CI rework budget `resolveMaxCiReworkRounds`, default 2, suppression
  guard) is unchanged, and the record is written alongside it. ADR-0174 (PR run-state comment) is
  untouched. Its recorder wrapper simply sees one more local update per round. ADR-0164: the
  durable record is enforced in code and tests. No new ADR is planned.
- **Docs and release hygiene:** a `CHANGELOG.md` `## Unreleased` `### Added` line ending in
  (#4311), plus the ops doc update. No `package.json` version edits. `docs/config.example.yaml` is
  untouched (no config change).
- **Safety:** the record holds only PR numbers and counts, with no secrets or paths. No shell
  interpolation: the test's child process gets the file path as an argv entry. No guardrail is
  weakened, and the CI rework cap and suppression guard are unchanged.
- **Scope:** only the files listed.

## Non-goals

- Changing the default cap (2) or when a CI rework round is triggered.
- Making `shipWithCiRework` start from, or enforce, the durable count. That is parts 2 and 3 of
  #4305.
- Mirroring the count into the PR run-state comment (`PrRunState`, ADR-0174).
- Any change to CHECK rework rounds or review rework.
