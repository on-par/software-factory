---
design:
  restatedProblem: >-
    `ci.skip: true` (or FACTORY_SKIP_CI=1) is resolved once by `resolveSkipCI`
    and fed both to SHIP (`RunRequest.skipCI` → `shipWithCiRework` passes
    `watchCI: !request.skipCI` to `shipPhase`) and to `factory land` (`land.ts`
    passes `skipCI` to `landPr`, which then skips `watchCi()`). An orchestrator
    that wants SHIP to open or update the PR and return right away, but still
    wants `factory land` to wait for and require green CI later, has no setting
    for that. We add `ship.watchCi` (default true). When it is false, SHIP does
    not call the CI watch, the run outcome and its `ready` event say CI was not
    watched, and land keeps reading only `ci.skip`, so its CI gate stays.
  approach:
    chosen: >-
      Add optional `watchCi: boolean` to the existing `ship` zod section in
      packages/core/src/config/index.ts, plus a pure resolver
      `resolveShipWatchCi(config)` (false only when `ship.watchCi === false`).
      buildRunRequest in packages/cli/src/cli/ship-steps.ts sets `shipWatchCi:
      false` on the RunRequest only in that case. In ci-rework-loop.ts, SHIP
      watches CI only when `!request.skipCI && request.shipWatchCi !== false`.
      In run-issue.ts, a `shipWatchCi === false` run without skipCI logs a
      `skip-ci` event, its ready message ends with " (CI not watched)", and the
      `ready` RunOutcome carries `ciWatched: false`. Land code is not changed:
      it already resolves only `resolveSkipCI`.
    rejected:
      - option: Add `ciWatched` to ShipResult inside shipPhase/finishShip
        reason: >-
          About 19 existing ship tests use `watchCI false` and assert exact
          `toEqual` results. The run-level outcome is where the result is
          reported, so the marker belongs there.
      - option: >-
          Make resolveSkipCI also read ship.watchCi, or split ci.skip into two
          flags
        reason: >-
          That changes what ci.skip means and touches land. The issue rules this
          out.
      - option: >-
          Add the field to the `--json` run-result schema
          (packages/cli/schemas/run-result.schema.json)
        reason: >-
          The schema is versioned with additionalProperties false, so this needs
          its own schemaVersion bump. The issue only asks for the run result,
          which is the RunOutcome plus its ready event.
  interfacesTouched:
    - >-
      packages/core/src/config/index.ts — FactoryConfigSchema `ship` section
      gains `watchCi`; new export `resolveShipWatchCi`
    - >-
      packages/core/src/index.ts — re-export `resolveShipWatchCi` next to
      `resolveCiWatchDeadlineMs`
    - >-
      packages/core/src/run/run-issue.ts — RunRequest gains `shipWatchCi?:
      boolean`; ready path logs it and sets `ciWatched: false`
    - >-
      packages/core/src/run/outcome.ts — RunOutcome `ready` variant gains
      `ciWatched?: false`
    - >-
      packages/core/src/run/ci-rework-loop.ts — shipOpts.watchCI also honours
      `request.shipWatchCi`
    - >-
      packages/cli/src/cli/ship-steps.ts — buildRunRequest sets `shipWatchCi:
      false` from config
    - >-
      packages/core/src/config/example.ts — documents `ship.watchCi`
      (docs/config.example.yaml regenerated)
  targetTypes:
    - name: RunRequest
      file: packages/core/src/run/run-issue.ts
      kind: changed
    - name: RunOutcome
      file: packages/core/src/run/outcome.ts
      kind: changed
    - name: FactoryConfig
      file: packages/core/src/config/index.ts
      kind: changed
    - name: ShipPhaseOptions
      file: packages/core/src/phases/ship-options.ts
      kind: read
  signatures:
    - symbol: resolveShipWatchCi
      file: packages/core/src/config/index.ts
      signature: >-
        export function resolveShipWatchCi(config: { ship?: { watchCi?: boolean
        } }): boolean
    - symbol: resolveSkipCI
      file: packages/core/src/config/index.ts
      signature: >-
        export function resolveSkipCI(config: FactoryConfig, env:
        NodeJS.ProcessEnv = process.env): boolean
    - symbol: buildRunRequest
      file: packages/cli/src/cli/ship-steps.ts
      signature: 'export function buildRunRequest(input: RunRequestInput): RunRequest'
    - symbol: shipWithCiRework
      file: packages/core/src/run/ci-rework-loop.ts
      signature: >-
        export async function shipWithCiRework(ctx: CiReworkLoopContext, inputs:
        CiReworkShipInputs): Promise<ShipWithCiReworkResult>
  callGraph:
    - from: buildRunRequest
      to: resolveShipWatchCi
      note: >-
        factoryConfig.ship.watchCi → `shipWatchCi false` on the RunRequest, set
        only when it is false
    - from: shipWithCiRework
      to: shipPhase
      note: watchCI is `!request.skipCI && request.shipWatchCi !== false`
    - from: runIssue
      to: shipWithCiRework
      note: >-
        the RunRequest carries shipWatchCi through; the ready branch reads it to
        log and to set `ciWatched false`
    - from: land
      to: resolveSkipCI
      note: 'unchanged; land never reads ship.watchCi, so its CI gate stays'
  behaviorContract:
    - >-
      With `ship.watchCi false` and ci.skip unset, shipPhase is called with
      `watchCI false`, so watchShipCi is never called. SHIP opens or updates the
      PR, marks it ready and returns.
    - >-
      That run's `ready` RunOutcome carries `ciWatched false`. Its `ready` event
      ends with "(CI not watched)", and a `skip-ci` event says land still
      requires green CI.
    - >-
      resolveSkipCI ignores ship.watchCi, so factory land / landPr still watch
      CI and refuse a non-green verdict.
    - >-
      ci.skip true behaves exactly as before. The RunOutcome gets no `ciWatched`
      field, and the existing FACTORY_SKIP_CI log line is unchanged.
    - >-
      When ship.watchCi is unset or true, the RunRequest has no shipWatchCi key,
      SHIP watches CI as today, and RunOutcome is unchanged.
    - >-
      A non-boolean `ship.watchCi` value is caught to undefined, which means the
      default (watch), the same way ciWatchMinutes is handled. Config loading
      never fails on it (ADR-0160).
  verificationPlan:
    - command: >-
        npx vitest run packages/core/src/config/ship-watch-ci.test.ts
        packages/core/src/run/ci-rework-loop.test.ts
        packages/cli/src/cli/ship-steps.test.ts
        packages/core/src/config/example.test.ts
      passWhen: all listed tests pass
    - command: npm run config-example && git diff --exit-code docs/config.example.yaml
      passWhen: >-
        the regenerated example is committed and the diff is empty after
        regeneration
    - command: bash scripts/verify.sh --no-e2e
      passWhen: full gate green (run by CHECK)
  riskBlastRadius: >-
    If the conjunction in ci-rework-loop is wrong, every SHIP could stop
    watching CI (PRs flipped ready on unverified heads), or ci.skip could start
    watching. Land would still gate merges, because land code is not touched. If
    the outcome field leaks into the ci.skip path, consumers that compare
    RunOutcome exactly would see a new key.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        Criterion 1 (SHIP returns without watching CI): with `shipWatchCi false`
        on the request, runIssue calls shipPhase with `watchCI false`
      test: >-
        packages/core/src/run/ci-rework-loop.test.ts "ship.watchCi false ships
        without the CI watch and reports CI not watched"
    - kind: fail-to-pass-test
      claim: >-
        Criterion 2 (run result says CI was not watched): the ready RunOutcome
        has `ciWatched false`, the ready event ends with "(CI not watched)", and
        a skip-ci event is logged
      test: >-
        packages/core/src/run/ci-rework-loop.test.ts "ship.watchCi false ships
        without the CI watch and reports CI not watched"
    - kind: fail-to-pass-test
      claim: >-
        Criterion 3 (land keeps its gate): a config file with `ship.watchCi
        false` and no ci.skip loads with resolveShipWatchCi false and
        resolveSkipCI false, which is the only flag land passes to landPr
      test: >-
        packages/core/src/config/ship-watch-ci.test.ts "ship.watchCi false does
        not set resolveSkipCI, so land keeps its CI gate"
    - kind: fail-to-pass-test
      claim: >-
        Criterion 4 (ci.skip unchanged): with `skipCI true`, shipPhase gets
        `watchCI false`, the outcome has no ciWatched key, and the
        FACTORY_SKIP_CI log line is unchanged
      test: >-
        packages/core/src/run/ci-rework-loop.test.ts "ci.skip still skips the
        SHIP CI watch without a ciWatched marker"
    - kind: fail-to-pass-test
      claim: >-
        Criterion 5 (default unchanged): with ship.watchCi unset,
        resolveShipWatchCi is true and buildRunRequest adds no shipWatchCi key;
        with ship.watchCi false it adds `shipWatchCi false`
      test: >-
        packages/cli/src/cli/ship-steps.test.ts "buildRunRequest sets
        shipWatchCi false only when ship.watchCi is false"
    - kind: fail-to-pass-test
      claim: >-
        Criterion 6 (schema documents ship.watchCi): the generated config
        example lists ship.watchCi with its default and how it differs from
        ci.skip
      test: >-
        packages/core/src/config/example.test.ts "documents ship.watchCi and how
        it differs from ci.skip"
  outline:
    - result: >-
        ship.watchCi loads from config, and resolveShipWatchCi returns false
        only for an explicit false
      files:
        - packages/core/src/config/index.ts
        - packages/core/src/index.ts
        - packages/core/src/config/ship-watch-ci.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/config/ship-watch-ci.test.ts
      manualChecks: []
    - result: >-
        buildRunRequest carries shipWatchCi false to the RunRequest, and SHIP
        skips the CI watch and reports `ciWatched false`
      files:
        - packages/cli/src/cli/ship-steps.ts
        - packages/cli/src/cli/ship-steps.test.ts
        - packages/core/src/run/run-issue.ts
        - packages/core/src/run/outcome.ts
        - packages/core/src/run/ci-rework-loop.ts
        - packages/core/src/run/ci-rework-loop.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/cli/src/cli/ship-steps.test.ts
          packages/core/src/run/ci-rework-loop.test.ts
      manualChecks: []
    - result: 'The config schema docs, runbook and changelog describe ship.watchCi'
      files:
        - packages/core/src/config/example.ts
        - packages/core/src/config/example.test.ts
        - docs/config.example.yaml
        - docs/runbooks/github-actions-run.md
        - CHANGELOG.md
      automatedChecks:
        - npx vitest run packages/core/src/config/example.test.ts
        - >-
          npm run config-example && git diff --exit-code
          docs/config.example.yaml
      manualChecks:
        - >-
          Read the ship section of docs/config.example.yaml and confirm the
          watchCi text matches the behaviour
  edgeInputs:
    - ship section absent
    - ship.watchCi unset
    - ship.watchCi true
    - ship.watchCi false
    - >-
      ship.watchCi a non-boolean (e.g. the string "false" or 0), which zod
      catches to undefined
    - ship.watchCi false together with ci.skip true or FACTORY_SKIP_CI=1
    - FACTORY_SKIP_CI=0 with ship.watchCi false
  behaviorDelta:
    - input: ship absent / watchCi unset
      branch: shipWatchCi key omitted
      before: SHIP watches CI
      after: SHIP watches CI; RunOutcome unchanged
      verdict: same
    - input: ship.watchCi true
      branch: shipWatchCi key omitted
      before: key stripped by zod; SHIP watches CI
      after: SHIP watches CI
      verdict: same
    - input: 'ship.watchCi false, ci.skip unset'
      branch: watchCI false in shipOpts
      before: key stripped (unknown-key warning); SHIP watches CI
      after: >-
        SHIP skips the CI watch, marks the PR ready, outcome has `ciWatched
        false`; land still gates on CI
      verdict: better
    - input: ship.watchCi non-boolean
      branch: catch(undefined) → default
      before: 'unknown key warning, SHIP watches CI'
      after: 'SHIP watches CI, no load failure'
      verdict: same
    - input: ci.skip true (any ship.watchCi)
      branch: skipCI true
      before: 'SHIP skips the watch, land skips its gate, FACTORY_SKIP_CI log'
      after: >-
        identical; no ciWatched key, the skip-ci log line is unchanged even if
        ship.watchCi is false
      verdict: same
    - input: FACTORY_SKIP_CI=0 with ship.watchCi false
      branch: 'skipCI false, shipWatchCi false'
      before: SHIP and land both watch CI
      after: SHIP skips the watch; land still watches CI
      verdict: better
  externalLists:
    - name: EventKind
      location: >-
        packages/core/src/events/kinds.ts (`skip-ci` is already a member,
        severity info)
      source: in-repo closed union; no new kind added
      gaps: []
---
---
route: codex
design:
  restatedProblem: >-
    `ci.skip: true` (or FACTORY_SKIP_CI=1) is resolved once by `resolveSkipCI` and fed both to SHIP
    (`RunRequest.skipCI` → `shipWithCiRework` passes `watchCI: !request.skipCI` to `shipPhase`) and to
    `factory land` (`land.ts` passes `skipCI` to `landPr`, which then skips `watchCi()`). An orchestrator
    that wants SHIP to open or update the PR and return right away, but still wants `factory land` to
    wait for and require green CI later, has no setting for that. We add `ship.watchCi` (default true).
    When it is false, SHIP does not call the CI watch, the run outcome and its `ready` event say CI was
    not watched, and land keeps reading only `ci.skip`, so its CI gate stays.
  approach:
    chosen: >-
      Add optional `watchCi: boolean` to the existing `ship` zod section in packages/core/src/config/index.ts,
      plus a pure resolver `resolveShipWatchCi(config)` (false only when `ship.watchCi === false`). buildRunRequest
      in packages/cli/src/cli/ship-steps.ts sets `shipWatchCi: false` on the RunRequest only in that case. In
      ci-rework-loop.ts, SHIP watches CI only when `!request.skipCI && request.shipWatchCi !== false`. In
      run-issue.ts, a `shipWatchCi === false` run without skipCI logs a `skip-ci` event, its ready message
      ends with " (CI not watched)", and the `ready` RunOutcome carries `ciWatched: false`. Land code is not
      changed: it already resolves only `resolveSkipCI`.
    rejected:
      - option: Add `ciWatched` to ShipResult inside shipPhase/finishShip
        reason: About 19 existing ship tests use `watchCI false` and assert exact `toEqual` results. The run-level outcome is where the result is reported, so the marker belongs there.
      - option: Make resolveSkipCI also read ship.watchCi, or split ci.skip into two flags
        reason: That changes what ci.skip means and touches land. The issue rules this out.
      - option: Add the field to the `--json` run-result schema (packages/cli/schemas/run-result.schema.json)
        reason: The schema is versioned with additionalProperties false, so this needs its own schemaVersion bump. The issue only asks for the run result, which is the RunOutcome plus its ready event.
  interfacesTouched:
    - packages/core/src/config/index.ts — FactoryConfigSchema `ship` section gains `watchCi`; new export `resolveShipWatchCi`
    - packages/core/src/index.ts — re-export `resolveShipWatchCi` next to `resolveCiWatchDeadlineMs`
    - packages/core/src/run/run-issue.ts — RunRequest gains `shipWatchCi?: boolean`; ready path logs it and sets `ciWatched: false`
    - packages/core/src/run/outcome.ts — RunOutcome `ready` variant gains `ciWatched?: false`
    - packages/core/src/run/ci-rework-loop.ts — shipOpts.watchCI also honours `request.shipWatchCi`
    - packages/cli/src/cli/ship-steps.ts — buildRunRequest sets `shipWatchCi: false` from config
    - packages/core/src/config/example.ts — documents `ship.watchCi` (docs/config.example.yaml regenerated)
  targetTypes:
    - name: RunRequest
      file: packages/core/src/run/run-issue.ts
      kind: changed
    - name: RunOutcome
      file: packages/core/src/run/outcome.ts
      kind: changed
    - name: FactoryConfig
      file: packages/core/src/config/index.ts
      kind: changed
    - name: ShipPhaseOptions
      file: packages/core/src/phases/ship-options.ts
      kind: read
  signatures:
    - symbol: resolveShipWatchCi
      file: packages/core/src/config/index.ts
      signature: 'export function resolveShipWatchCi(config: { ship?: { watchCi?: boolean } }): boolean'
    - symbol: resolveSkipCI
      file: packages/core/src/config/index.ts
      signature: 'export function resolveSkipCI(config: FactoryConfig, env: NodeJS.ProcessEnv = process.env): boolean'
    - symbol: buildRunRequest
      file: packages/cli/src/cli/ship-steps.ts
      signature: 'export function buildRunRequest(input: RunRequestInput): RunRequest'
    - symbol: shipWithCiRework
      file: packages/core/src/run/ci-rework-loop.ts
      signature: 'export async function shipWithCiRework(ctx: CiReworkLoopContext, inputs: CiReworkShipInputs): Promise<ShipWithCiReworkResult>'
  callGraph:
    - from: buildRunRequest
      to: resolveShipWatchCi
      note: factoryConfig.ship.watchCi → `shipWatchCi false` on the RunRequest, set only when it is false
    - from: shipWithCiRework
      to: shipPhase
      note: watchCI is `!request.skipCI && request.shipWatchCi !== false`
    - from: runIssue
      to: shipWithCiRework
      note: the RunRequest carries shipWatchCi through; the ready branch reads it to log and to set `ciWatched false`
    - from: land
      to: resolveSkipCI
      note: unchanged; land never reads ship.watchCi, so its CI gate stays
  behaviorContract:
    - With `ship.watchCi false` and ci.skip unset, shipPhase is called with `watchCI false`, so watchShipCi is never called. SHIP opens or updates the PR, marks it ready and returns.
    - That run's `ready` RunOutcome carries `ciWatched false`. Its `ready` event ends with "(CI not watched)", and a `skip-ci` event says land still requires green CI.
    - resolveSkipCI ignores ship.watchCi, so factory land / landPr still watch CI and refuse a non-green verdict.
    - ci.skip true behaves exactly as before. The RunOutcome gets no `ciWatched` field, and the existing FACTORY_SKIP_CI log line is unchanged.
    - When ship.watchCi is unset or true, the RunRequest has no shipWatchCi key, SHIP watches CI as today, and RunOutcome is unchanged.
    - A non-boolean `ship.watchCi` value is caught to undefined, which means the default (watch), the same way ciWatchMinutes is handled. Config loading never fails on it (ADR-0160).
  verificationPlan:
    - command: npx vitest run packages/core/src/config/ship-watch-ci.test.ts packages/core/src/run/ci-rework-loop.test.ts packages/cli/src/cli/ship-steps.test.ts packages/core/src/config/example.test.ts
      passWhen: all listed tests pass
    - command: npm run config-example && git diff --exit-code docs/config.example.yaml
      passWhen: the regenerated example is committed and the diff is empty after regeneration
    - command: bash scripts/verify.sh --no-e2e
      passWhen: full gate green (run by CHECK)
  riskBlastRadius: >-
    If the conjunction in ci-rework-loop is wrong, every SHIP could stop watching CI (PRs flipped ready on
    unverified heads), or ci.skip could start watching. Land would still gate merges, because land code is
    not touched. If the outcome field leaks into the ci.skip path, consumers that compare RunOutcome exactly
    would see a new key.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: 'Criterion 1 (SHIP returns without watching CI): with `shipWatchCi false` on the request, runIssue calls shipPhase with `watchCI false`'
      test: packages/core/src/run/ci-rework-loop.test.ts "ship.watchCi false ships without the CI watch and reports CI not watched"
    - kind: fail-to-pass-test
      claim: 'Criterion 2 (run result says CI was not watched): the ready RunOutcome has `ciWatched false`, the ready event ends with "(CI not watched)", and a skip-ci event is logged'
      test: packages/core/src/run/ci-rework-loop.test.ts "ship.watchCi false ships without the CI watch and reports CI not watched"
    - kind: fail-to-pass-test
      claim: 'Criterion 3 (land keeps its gate): a config file with `ship.watchCi false` and no ci.skip loads with resolveShipWatchCi false and resolveSkipCI false, which is the only flag land passes to landPr'
      test: packages/core/src/config/ship-watch-ci.test.ts "ship.watchCi false does not set resolveSkipCI, so land keeps its CI gate"
    - kind: fail-to-pass-test
      claim: 'Criterion 4 (ci.skip unchanged): with `skipCI true`, shipPhase gets `watchCI false`, the outcome has no ciWatched key, and the FACTORY_SKIP_CI log line is unchanged'
      test: packages/core/src/run/ci-rework-loop.test.ts "ci.skip still skips the SHIP CI watch without a ciWatched marker"
    - kind: fail-to-pass-test
      claim: 'Criterion 5 (default unchanged): with ship.watchCi unset, resolveShipWatchCi is true and buildRunRequest adds no shipWatchCi key; with ship.watchCi false it adds `shipWatchCi false`'
      test: packages/cli/src/cli/ship-steps.test.ts "buildRunRequest sets shipWatchCi false only when ship.watchCi is false"
    - kind: fail-to-pass-test
      claim: 'Criterion 6 (schema documents ship.watchCi): the generated config example lists ship.watchCi with its default and how it differs from ci.skip'
      test: packages/core/src/config/example.test.ts "documents ship.watchCi and how it differs from ci.skip"
  outline:
    - result: ship.watchCi loads from config, and resolveShipWatchCi returns false only for an explicit false
      files:
        - packages/core/src/config/index.ts
        - packages/core/src/index.ts
        - packages/core/src/config/ship-watch-ci.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/config/ship-watch-ci.test.ts
      manualChecks: []
    - result: buildRunRequest carries shipWatchCi false to the RunRequest, and SHIP skips the CI watch and reports `ciWatched false`
      files:
        - packages/cli/src/cli/ship-steps.ts
        - packages/cli/src/cli/ship-steps.test.ts
        - packages/core/src/run/run-issue.ts
        - packages/core/src/run/outcome.ts
        - packages/core/src/run/ci-rework-loop.ts
        - packages/core/src/run/ci-rework-loop.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/ship-steps.test.ts packages/core/src/run/ci-rework-loop.test.ts
      manualChecks: []
    - result: The config schema docs, runbook and changelog describe ship.watchCi
      files:
        - packages/core/src/config/example.ts
        - packages/core/src/config/example.test.ts
        - docs/config.example.yaml
        - docs/runbooks/github-actions-run.md
        - CHANGELOG.md
      automatedChecks:
        - npx vitest run packages/core/src/config/example.test.ts
        - npm run config-example && git diff --exit-code docs/config.example.yaml
      manualChecks:
        - Read the ship section of docs/config.example.yaml and confirm the watchCi text matches the behaviour
  edgeInputs:
    - ship section absent
    - ship.watchCi unset
    - ship.watchCi true
    - ship.watchCi false
    - ship.watchCi a non-boolean (e.g. the string "false" or 0), which zod catches to undefined
    - ship.watchCi false together with ci.skip true or FACTORY_SKIP_CI=1
    - FACTORY_SKIP_CI=0 with ship.watchCi false
  behaviorDelta:
    - input: ship absent / watchCi unset
      branch: shipWatchCi key omitted
      before: SHIP watches CI
      after: SHIP watches CI; RunOutcome unchanged
      verdict: same
    - input: ship.watchCi true
      branch: shipWatchCi key omitted
      before: key stripped by zod; SHIP watches CI
      after: SHIP watches CI
      verdict: same
    - input: ship.watchCi false, ci.skip unset
      branch: watchCI false in shipOpts
      before: key stripped (unknown-key warning); SHIP watches CI
      after: SHIP skips the CI watch, marks the PR ready, outcome has `ciWatched false`; land still gates on CI
      verdict: better
    - input: ship.watchCi non-boolean
      branch: catch(undefined) → default
      before: unknown key warning, SHIP watches CI
      after: SHIP watches CI, no load failure
      verdict: same
    - input: ci.skip true (any ship.watchCi)
      branch: skipCI true
      before: SHIP skips the watch, land skips its gate, FACTORY_SKIP_CI log
      after: identical; no ciWatched key, the skip-ci log line is unchanged even if ship.watchCi is false
      verdict: same
    - input: FACTORY_SKIP_CI=0 with ship.watchCi false
      branch: skipCI false, shipWatchCi false
      before: SHIP and land both watch CI
      after: SHIP skips the watch; land still watches CI
      verdict: better
  externalLists:
    - name: EventKind
      location: packages/core/src/events/kinds.ts (`skip-ci` is already a member, severity info)
      source: in-repo closed union; no new kind added
      gaps: []
---
# Spec: Let SHIP skip its CI watch without removing the land CI gate (ship.watchCi: false) (#4304)

## Goal

`ci.skip` turns off two things at once: SHIP's CI watch and `factory land`'s CI gate. We add
`ship.watchCi` (boolean, default `true`). When it is `false`, SHIP opens or updates the PR, marks it ready,
and returns without watching CI. The run outcome and its events say CI was not watched. `factory land` reads
only `ci.skip`, as it does today, so it still waits for green CI. With this, an orchestrator can run "ship
now, land later" without losing the merge gate.

## Files / approach

1. **packages/core/src/config/index.ts**
   - In `FactoryConfigSchema`, extend the `ship` object:
     `z.object({ ciWatchMinutes: z.number().optional().catch(undefined), watchCi: z.boolean().optional().catch(undefined), comment: z.string().optional() }).default({})`.
     The `.catch(undefined)` follows the `ciWatchMinutes` pattern: a bad value means the default and never fails the load (ADR-0160).
   - Add, next to `resolveCiWatchDeadlineMs`:
     ```ts
     export function resolveShipWatchCi(config: { ship?: { watchCi?: boolean } }): boolean {
       return config.ship?.watchCi !== false;
     }
     ```
     Do not change `resolveSkipCI`. It must keep reading only `ci.skip` / `FACTORY_SKIP_CI`.
2. **packages/core/src/index.ts**: re-export `resolveShipWatchCi` from the same `./config/index.js` export block that has `resolveCiWatchDeadlineMs` and `resolveSkipCI`.
3. **packages/core/src/run/run-issue.ts**
   - `RunRequest`: add `shipWatchCi?: boolean;` right after `skipCI: boolean;`.
   - In the ready path (around line 1130), keep the existing `if (request.skipCI) log('skip-ci', …)` line as it is. Add
     `else if (request.shipWatchCi === false) log('skip-ci', 'not watching CI (ship.watchCi: false); factory land still waits for and requires green CI');`.
   - Compute `const ciNotWatched = !request.skipCI && request.shipWatchCi === false;`. When true, add `' (CI not watched)'`
     to the non-`alreadyDelivered` ready message, and add `...(ciNotWatched ? { ciWatched: false as const } : {})` to the returned `ready` outcome.
4. **packages/core/src/run/outcome.ts**: in the `state: 'ready'` RunOutcome variant, add `ciWatched?: false;`.
5. **packages/core/src/run/ci-rework-loop.ts**: in `shipOpts`, change `watchCI: !request.skipCI` to
   `watchCI: !request.skipCI && request.shipWatchCi !== false`. The CI rework re-entry reuses `shipOpts`, so it follows automatically. With no watch there is no `ciFailure`, so no rework round can start.
6. **packages/cli/src/cli/ship-steps.ts**: import `resolveShipWatchCi` from `@on-par/factory-core` (same import list as `resolveCiWatchDeadlineMs`). In `buildRunRequest`, after `ciDeadlineMs`, add
   `...(resolveShipWatchCi(factoryConfig) ? {} : { shipWatchCi: false }),`.
7. **packages/core/src/config/example.ts**: in the block that pushes `ciWatchMinutes` onto the `ship` section, also push
   `{ kind: 'unset', key: 'watchCi', doc: 'false: SHIP opens or updates the PR and returns without watching CI; the run result says CI was not watched. factory land still waits for and requires green CI. Unlike ci.skip, which skips both the SHIP watch and the land CI gate. Unset: true.', example: 'false' }`.
   Then run `npm run config-example` to regenerate **docs/config.example.yaml**. Never hand-edit that file.
8. **docs/runbooks/github-actions-run.md**: next to the `ship.ciWatchMinutes` sentence (line ~85), add one sentence: `ship.watchCi: false` makes SHIP return without watching CI, while `factory land` still requires green CI. This differs from `ci.skip`, which removes both.
9. **CHANGELOG.md**: under `## Unreleased` → `### Added`, add:
   `- ship: \`ship.watchCi: false\` makes SHIP open or update the PR and return without watching CI (the run result says CI was not watched), while \`factory land\` still requires green CI; \`ci.skip\` is unchanged (#4304)`.

Land (`packages/cli/src/cli/land.ts`, `land-pr.ts`, `index.ts` land commands) is **not** edited.

## Tests

- **New: packages/core/src/config/ship-watch-ci.test.ts**. Use `createTempDirs` and `loadFactoryConfigForRepo` the way `ci-watch-deadline.test.ts` does.
  - `"resolveShipWatchCi defaults to true and is false only for an explicit false"`: `{}`, `{ ship: {} }`, `{ ship: { watchCi: true } }` give true; `{ ship: { watchCi: false } }` gives false.
  - `"ship.watchCi false does not set resolveSkipCI, so land keeps its CI gate"`: write `version: 2\nship:\n  watchCi: false\n` to `.factory/config.yaml` and load it. Expect `resolveShipWatchCi(cfg) === false` and `resolveSkipCI(cfg, {}) === false`.
  - `"a non-boolean ship.watchCi loads and resolves to the default"`: a config with `watchCi: "nope"` loads without throwing, and resolveShipWatchCi gives true.
- **packages/core/src/run/ci-rework-loop.test.ts** (it already drives `runIssue` with a mocked `shipPhase`):
  - `"ship.watchCi false ships without the CI watch and reports CI not watched"`: `shipPhase.mockResolvedValue({ ok: true, prNumber: 9 })`, then `runIssue({ ...request, shipWatchCi: false }, …)`. Expect `shipPhase` called with `expect.objectContaining({ watchCI: false })`, the outcome to include `{ state: 'ready', ciWatched: false }`, a `skip-ci` event mentioning `ship.watchCi`, and a `ready` event containing `(CI not watched)`. Copy the runIssue call shape from existing tests in this file.
  - `"ci.skip still skips the SHIP CI watch without a ciWatched marker"`: `{ ...request, skipCI: true }`. Expect `watchCI: false`, an outcome with no `ciWatched` property, and the `skip-ci` event text `skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify`.
  - `"default request watches CI"`: plain `request`. Expect `watchCI: true` and no `ciWatched`.
- **packages/cli/src/cli/ship-steps.test.ts**: `"buildRunRequest sets shipWatchCi false only when ship.watchCi is false"`. Use the existing input fixture: `factoryConfig: { sandbox: {} }` gives no `shipWatchCi` key, and `factoryConfig: { sandbox: {}, ship: { watchCi: false } }` gives `shipWatchCi: false`. `skipCI` is false in both.
- **packages/core/src/config/example.test.ts**: `"documents ship.watchCi and how it differs from ci.skip"`. The generated example text contains `watchCi: false` and `ci.skip`.

Command: `npx vitest run packages/core/src/config/ship-watch-ci.test.ts packages/core/src/run/ci-rework-loop.test.ts packages/cli/src/cli/ship-steps.test.ts packages/core/src/config/example.test.ts` (from the repo root). CHECK then runs `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- **Verify gate**: BUILD runs the focused vitest command above and reports it. CHECK runs the full `verify.sh --no-e2e`. No coverage threshold is lowered. If the ratchet reports a rise, raise the threshold in the same change. No tests are skipped. No inline lint disables.
- **No comments**: the new code adds no comments. The doc text lives in `example.ts` data strings, not in comments.
- **Tests**: every changed source file has a colocated test (config/index.ts → new ship-watch-ci.test.ts; run-issue.ts, outcome.ts and ci-rework-loop.ts → ci-rework-loop.test.ts, which drives runIssue; ship-steps.ts → ship-steps.test.ts; example.ts → example.test.ts). Without the change, each new test fails: the export, the field and the key do not exist yet.
- **Architecture**: config ← core ← cli is respected. cli imports `resolveShipWatchCi` from the published `@on-par/factory-core` root, as it already does for `resolveCiWatchDeadlineMs`. No model ids are touched. Relative imports use `.js`. Domain terms (land, park, run) are used as in CONTEXT.md. No ADR: this is a small config option inside ADR-0170/0171's land gate, which it leaves intact.
- **Docs and release hygiene**: a CHANGELOG `### Added` line ending in (#4304). The runbook is updated. `docs/config.example.yaml` is regenerated with `npm run config-example`, never hand-edited. No package.json versions are touched.
- **Safety**: land guardrails are untouched, so required checks and the land CI gate still apply. No shell is built from inputs. No secrets.
- **ADR-0160**: the new key is optional, and a bad value is caught to the default. Nothing that loads today stops loading.

## Non-goals

- Any change to the meaning or default of `ci.skip` / `FACTORY_SKIP_CI`.
- Any change to `factory land` / `landPr` CI gating.
- A `--json` run-result schema change (`packages/cli/schemas/run-result.schema.json`), or a `ciWatched` field on `ShipResult`.
- Changing the BUILD prompt's CI wording (`build-prompts.ts` still keys off `skipCI`).
- New CI providers, watchers, or reporting formats.
