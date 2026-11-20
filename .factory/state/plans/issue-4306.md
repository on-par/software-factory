---
design:
  restatedProblem: >-
    `factory land <issue>` (cmdLand in packages/cli/src/cli/index.ts) turns
    every "left open, not merged" outcome into a printed yellow line and a
    normal return, so a CI-watch timeout (CiUnverifiedError / AwaitingCiError /
    BaseCiPendingError, matched by isCiNotGreen) and a confirmed failing check
    (CiFailedError) both exit 0 and differ only in human text. An external
    orchestrator cannot tell "checks still running, retry later" from "red CI"
    without scraping stdout, and `factory land` has no `--json` contract even
    though docs/cli-json-schemas.md reserves one. This slice adds a structured
    land result (`merged`, `checks_pending`, `checks_failed`, `conflicting`,
    `closed`), makes the checks-pending case exit 75 (EX_TEMPFAIL), adds
    `--json` that prints one final machine-readable line, and documents the
    shape with a generated schema and golden fixture. The CI watch, its timing,
    `ci.skip`, the merge gate and every other exit code stay unchanged.
  approach:
    chosen: >-
      Keep landIssue's control flow; classify its outcome in cmdLand. Add a new
      module packages/cli/src/cli/land-result.ts that owns the result kind, the
      exit-75 constant, a best-effort GraphQL snapshot of the PR (headRefOid,
      mergeable, pending/failed check names from statusCheckRollup) and a
      builder that produces a landResultJsonSchema-valid object. landIssue gains
      one optional `onPrResolved` callback (so cmdLand knows the PR number for a
      conflict) and throws a new LandNoOpenPrError subclass of LandFailureError
      (same message, same code 1) carrying the branch guesses, so cmdLand can
      detect an already closed PR via latestPrForBranch. The snapshot read only
      happens with --json, so the default path makes no new API calls. Pending
      throws CliExitError('', 75) and main() skips printing an empty message, so
      human output is byte-identical.
    rejected:
      - option: >-
          Thread the CI watch's pending/failed check names and head SHA through
          every land error class (CiFailedError, CiUnverifiedError,
          AwaitingCiError, LandConflictError).
        reason: >-
          Touches the core CI watch and a dozen throw sites in land-pr.ts and
          core; far larger blast radius than a post-hoc read for a
          reporting-only feature.
      - option: 'Emit the JSON without schemaVersion, exactly as sketched in the issue.'
        reason: >-
          docs/cli-json-schemas.md treats unversioned output as legacy-only
          (logs-line); every new envelope is versioned. Adding `schemaVersion`
          as an extra leading key keeps the issue's keys and order intact and is
          additive for consumers.
      - option: >-
          Add more result values (awaiting_review, gated, failed) so every land
          path prints JSON.
        reason: >-
          The issue fixes the enum to five values; extending the public enum is
          an API decision for a later slice (recorded in openQuestions).
      - option: Exit 75 only when --json is passed.
        reason: >-
          The issue requires exit 75 for pending checks as the distinct signal,
          independent of --json.
  interfacesTouched:
    - >-
      packages/cli/src/cli/land-result.ts (new) — LandResultKind,
      LAND_EXIT_CHECKS_PENDING, LandSnapshot, readLandSnapshot,
      buildLandResultJson, formatLandResultLine
    - >-
      packages/cli/src/cli/json-contract.ts — new landResultJsonSchema +
      LandResultJson type
    - >-
      packages/cli/src/cli/land-pr.ts — new LandNoOpenPrError extends
      LandFailureError
    - >-
      packages/cli/src/cli/land.ts — landIssue opts.onPrResolved; throws
      LandNoOpenPrError for "no open PR"
    - >-
      packages/cli/src/cli/index.ts — cmdLand opts.json, result classification,
      exit 75; main() skips console.error for an empty CliExitError message
    - packages/cli/src/cli/program-run-work.ts — `land <issue>` gets `--json`
    - scripts/gen-cli-json-schemas.ts — registers land-result.schema.json
    - packages/cli/schemas/land-result.schema.json (generated)
    - packages/cli/src/cli/__fixtures__/json/land-result.json (golden fixture)
    - >-
      docs/cli-json-schemas.md, README.md, docs/runbooks/github-actions-run.md,
      CHANGELOG.md
  targetTypes:
    - name: LandResultKind
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandSnapshot
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandResultJson
      file: packages/cli/src/cli/json-contract.ts
      kind: added
    - name: LandNoOpenPrError
      file: packages/cli/src/cli/land-pr.ts
      kind: added
    - name: LandFailureError
      file: packages/cli/src/cli/land-pr.ts
      kind: read
    - name: CliExitError
      file: packages/cli/src/cli/errors.ts
      kind: read
  signatures:
    - symbol: readLandSnapshot
      file: packages/cli/src/cli/land-result.ts
      signature: >-
        export async function readLandSnapshot(octokit: Octokit, owner: string,
        repoName: string, prNumber: number): Promise<LandSnapshot>
    - symbol: buildLandResultJson
      file: packages/cli/src/cli/land-result.ts
      signature: >-
        export function buildLandResultJson(result: LandResultKind, prNumber:
        number, snapshot: LandSnapshot): LandResultJson
    - symbol: formatLandResultLine
      file: packages/cli/src/cli/land-result.ts
      signature: 'export function formatLandResultLine(json: LandResultJson): string'
    - symbol: landIssue
      file: packages/cli/src/cli/land.ts
      signature: >-
        export async function landIssue(issueNum: number, repoRoot: string,
        ghRepo: string, paths: ReturnType<typeof getFactoryPaths>, octokit:
        Octokit, skipCI?: boolean, branchPrefix?: string, opts?: { allowGated?:
        boolean; branch?: string; enforceRisk?: boolean; syncMain?: boolean;
        holdsLandingSlot?: boolean; rebuildOnConflict?: boolean; signal?:
        AbortSignal; mergeOverrides?: MergePolicyOverrides; issueless?: boolean;
        onPrResolved?: (pr: { prNumber: number; branch: string }) => void }):
        Promise<{ branch: string; prNumber: number }>
    - symbol: cmdLand
      file: packages/cli/src/cli/index.ts
      signature: >-
        export async function cmdLand(issueNum: number, opts?: { branchPrefix?:
        string; allowGated?: boolean; json?: boolean }, deps?: Pick<CliDeps,
        ConfigLoaderKey | GitOpKey | InternalOpKey | ShellOpKey | 'octokit'>):
        Promise<void>
  callGraph:
    - from: cmdLand
      to: landIssue
      note: >-
        passes onPrResolved to learn prNumber/branch before any conflict can be
        thrown
    - from: cmdLand
      to: readLandSnapshot
      note: >-
        only when opts.json; reads headSha, mergeable, pending and failed check
        names for the PR
    - from: cmdLand
      to: latestPrForBranch
      note: >-
        on LandNoOpenPrError with --json, finds a closed/merged PR on one of
        err.branches to report `closed`
    - from: cmdLand
      to: buildLandResultJson
      note: >-
        result kind + pr + snapshot -> schema-valid object, printed via
        formatLandResultLine as the last stdout line
    - from: main
      to: cmdLand
      note: >-
        CliExitError code 75 with empty message sets process.exitCode without a
        stderr line
  behaviorContract:
    - >-
      A CI outcome matched by isCiNotGreen (CI-watch timeout, no checks ever
      registered, base CI pending, land deferred) still prints the same yellow
      "CI never reached a green verdict — left open, not merged" line but now
      makes `factory land` exit 75 instead of 0.
    - >-
      `factory land --json` prints, as its final stdout line, one JSON object
      valid against landResultJsonSchema:
      {"schemaVersion":1,"result":...,"pr":n,"headSha":string|null,"pending":[...]
      | "failed":[...],"mergeable":"MERGEABLE"|"CONFLICTING"|"UNKNOWN"}.
    - >-
      A successful merge reports `merged` and exits 0; a confirmed failing check
      (CiFailedError that is not CiUnverifiedError, including CiInfraError)
      reports `checks_failed` with a `failed` array and still exits 0; a
      LandConflictError reports `conflicting` and still exits 3; no open PR but
      a closed (or merged) PR on the branch reports `closed` and still exits 1.
    - >-
      Without --json, stdout and stderr lines are byte-identical to before for
      every outcome, and no extra GitHub API call is made.
    - >-
      Outcomes outside the five results (awaiting review, merge-gated, ambiguous
      lookup, lookup failure, no PR at all, generic merge failure) keep their
      exact current output and exit codes and print no JSON line.
  verificationPlan:
    - command: >-
        npx vitest run packages/cli/src/cli/land-result.test.ts
        packages/cli/src/cli/land.json.test.ts packages/cli/src/cli/land.test.ts
        packages/cli/src/cli/json-contract.test.ts
      passWhen: >-
        all tests pass, including the new per-result exit-code and JSON-shape
        tests
    - command: bash scripts/check-cli-json-schemas.sh
      passWhen: >-
        prints "check-cli-json-schemas: OK" (committed land-result.schema.json
        matches the Zod schema)
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (run by CHECK before SHIP)
  riskBlastRadius: >-
    `factory land` exit code changes from 0 to 75 for the CI-not-green case.
    scripts/factory-run.sh already propagates land's non-zero exit and writes an
    ::error:: line, so a hosted Actions run whose land times out on CI now fails
    visibly instead of passing silently with the PR open; this is intended and
    documented in the runbook. landIssue's other callers (waitForMerge,
    resume-approved, run-issue --merge, lanes) do not use onPrResolved and still
    see a LandFailureError (LandNoOpenPrError is a subclass with the same
    message and code), so their behaviour is unchanged. A wrong main() change
    (skipping empty messages) could hide an error message only if some caller
    throws CliExitError(''), which none does today.
  openQuestions:
    - >-
      Outcomes the issue does not name (awaiting human review, merge-gated exit
      4, ambiguous/no PR, lookup failure, generic merge failure exit 5) print no
      JSON line in this slice; adding result values for them is a follow-up API
      decision.
    - >-
      The JSON line adds a leading "schemaVersion":1 key beyond the issue
      sketch, to match the versioned-envelope rule in docs/cli-json-schemas.md;
      all sketched keys and their order are kept.
    - >-
      A PR that is already merged when `factory land` runs (no open PR, latest
      PR merged) reports `closed` with exit 1, because the merge did not happen
      in this invocation.
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        `factory land --json` prints a documented final JSON line for merged,
        checks_pending, checks_failed, conflicting, and closed — each scenario's
        last stdout line parses and validates against landResultJsonSchema with
        the expected `result`
      test: >-
        packages/cli/src/cli/land.json.test.ts "prints a merged result line on a
        successful merge" "prints a checks_pending result line when CI never
        reaches a green verdict" "prints a checks_failed result line with failed
        check names" "prints a conflicting result line on a land conflict"
        "prints a closed result line when the PR is already closed"
    - kind: fail-to-pass-test
      claim: >-
        Checks still pending (including a CI-watch timeout that leaves the PR
        open) exit 75 and report checks_pending — watchChecks 'timeout' makes
        cmdLand reject with CliExitError code 75 and main() sets
        process.exitCode 75 with no stderr line
      test: >-
        packages/cli/src/cli/land.json.test.ts "exits 75 when CI never reaches a
        green verdict" "main sets exit code 75 without printing an error line"
    - kind: fail-to-pass-test
      claim: >-
        A successful merge exits 0 and reports merged — cmdLand --json resolves
        and the last line has result merged, the PR number and pending []
      test: >-
        packages/cli/src/cli/land.json.test.ts "prints a merged result line on a
        successful merge"
    - kind: fail-to-pass-test
      claim: >-
        A failing check reports checks_failed and is otherwise handled as today
        — watchChecks 'failure' still resolves (exit 0), prints the failing-CI
        line, does not merge, and the JSON line has result checks_failed and a
        failed array
      test: >-
        packages/cli/src/cli/land.json.test.ts "prints a checks_failed result
        line with failed check names"
    - kind: fail-to-pass-test
      claim: >-
        Without --json the human-readable lines stay the same — for merged,
        failing CI and timeout the captured stdout equals the exact pre-change
        lines and contains no JSON, and no snapshot GraphQL query is issued
      test: >-
        packages/cli/src/cli/land.json.test.ts "keeps human output unchanged and
        reads no snapshot without --json"
    - kind: fail-to-pass-test
      claim: >-
        The shapes are documented in docs/cli-json-schemas.md — the land-result
        golden fixture validates against the committed generated
        land-result.schema.json
      test: >-
        packages/cli/src/cli/json-contract.test.ts "validates every golden
        fixture against its committed generated schema"
    - kind: fail-to-pass-test
      claim: >-
        Unit tests cover each result and exit code — snapshot parsing maps
        CheckRun/StatusContext states to pending and failed names, degrades to
        UNKNOWN/null on error, and the builder emits `failed` only for
        checks_failed
      test: >-
        packages/cli/src/cli/land-result.test.ts "collects pending and failed
        check names from the status rollup" "returns an unknown snapshot when
        the read fails" "uses failed instead of pending for checks_failed"
  outline:
    - result: >-
        landResultJsonSchema, its generated schema and golden fixture exist and
        validate
      files:
        - packages/cli/src/cli/json-contract.ts
        - packages/cli/src/cli/json-contract.test.ts
        - packages/cli/src/cli/__fixtures__/json/land-result.json
        - scripts/gen-cli-json-schemas.ts
        - packages/cli/schemas/land-result.schema.json
      automatedChecks:
        - npx vitest run packages/cli/src/cli/json-contract.test.ts
        - bash scripts/check-cli-json-schemas.sh
      manualChecks: []
    - result: >-
        land-result.ts reads a PR snapshot and builds a schema-valid result for
        each of the five kinds
      files:
        - packages/cli/src/cli/land-result.ts
        - packages/cli/src/cli/land-result.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land-result.test.ts
      manualChecks: []
    - result: >-
        cmdLand classifies outcomes, exits 75 on pending, prints the JSON line
        with --json, and keeps human output unchanged
      files:
        - packages/cli/src/cli/land-pr.ts
        - packages/cli/src/cli/land.ts
        - packages/cli/src/cli/index.ts
        - packages/cli/src/cli/program-run-work.ts
        - packages/cli/src/cli/land.test.ts
        - packages/cli/src/cli/land.json.test.ts
      automatedChecks:
        - >-
          npx vitest run packages/cli/src/cli/land.json.test.ts
          packages/cli/src/cli/land.test.ts
      manualChecks:
        - >-
          Run `factory land <N> --json` against a PR whose CI is still running
          and confirm `echo $?` prints 75 and the last line has
          "result":"checks_pending"
    - result: >-
        Docs and changelog describe the result values, exit 75 and the JSON
        contract
      files:
        - docs/cli-json-schemas.md
        - README.md
        - docs/runbooks/github-actions-run.md
        - CHANGELOG.md
      automatedChecks:
        - >-
          npx prettier --check docs/cli-json-schemas.md README.md
          docs/runbooks/github-actions-run.md CHANGELOG.md
      manualChecks: []
  edgeInputs:
    - CiUnverifiedError from a watchChecks 'timeout' / no-verdict outcome
    - 'LandDeferredError (CiUnverifiedError subclass, base kept moving)'
    - AwaitingCiError (no check run or status ever registered)
    - BaseCiPendingError (base CI still pending)
    - 'CiInfraError (CiFailedError subclass, infra rerun failed)'
    - plain CiFailedError (confirmed failing check)
    - AwaitingReviewError (risk or review gate)
    - MergeGatedError
    - LandConflictError with and without `rebuild`
    - >-
      LandNoOpenPrError where the branch has a closed PR, a merged PR, or no PR
      at all
    - >-
      other LandFailureError (ambiguous lookup code 1, lookup failure code 5,
      merge failure code 5)
    - VisualProofMissingError and any unknown error (generic code-5 fallthrough)
    - >-
      snapshot GraphQL read throwing, returning no pullRequest, or an
      empty/absent statusCheckRollup
    - mergeable values outside MERGEABLE/CONFLICTING (null or unexpected string)
  behaviorDelta:
    - input: 'isCiNotGreen error (timeout, LandDeferred, AwaitingCi, BaseCiPending)'
      branch: isCiNotGreen
      before: 'yellow "CI never reached a green verdict" line, exit 0'
      after: 'same line, exit 75; with --json also a checks_pending line'
      verdict: better
    - input: CiFailedError / CiInfraError
      branch: instanceof CiFailedError
      before: 'yellow "failing CI check" line, exit 0'
      after: 'same line, exit 0; with --json also a checks_failed line'
      verdict: same
    - input: successful merge
      branch: success
      before: 'green "Landed PR" line, exit 0'
      after: 'same line, exit 0; with --json also a merged line'
      verdict: same
    - input: LandConflictError
      branch: instanceof LandConflictError
      before: 'stderr message, exit 3'
      after: 'same, exit 3; with --json a conflicting line on stdout first'
      verdict: same
    - input: LandNoOpenPrError (branch has a closed or merged PR)
      branch: no open PR
      before: 'stderr "no open PR" message, exit 1'
      after: 'same message, exit 1; with --json a closed line on stdout first'
      verdict: same
    - input: >-
        LandNoOpenPrError (no PR on any guessed branch) or latestPrForBranch
        throws
      branch: no open PR
      before: 'stderr "no open PR" message, exit 1'
      after: 'unchanged, no JSON line'
      verdict: same
    - input: >-
        AwaitingReviewError, MergeGatedError, other LandFailureError,
        VisualProofMissingError, unknown error
      branch: existing branches and generic fallthrough
      before: 'current lines and exit codes (0, 4, err.code, 5)'
      after: 'unchanged, no JSON line'
      verdict: same
    - input: snapshot read fails or mergeable is null/unknown
      branch: readLandSnapshot catch / mergeable normalisation
      before: n/a (no snapshot)
      after: >-
        headSha null (or AwaitingCiError.headSha), mergeable UNKNOWN, empty
        arrays; result and exit code unaffected
      verdict: better
    - input: >-
        GitHub Actions factory-run.sh running `factory land` whose CI watch
        times out
      branch: rc != 0 in factory-run.sh
      before: job passed with the PR left open
      after: 'job fails with exit 75 and an ::error:: line naming the land exit'
      verdict: better
  externalLists:
    - name: GitHub GraphQL MergeableState enum
      location: packages/cli/src/cli/json-contract.ts landResultJsonSchema.mergeable
      source: >-
        https://docs.github.com/en/graphql/reference/enums#mergeablestate
        (CONFLICTING, MERGEABLE, UNKNOWN)
      gaps: []
    - name: GitHub GraphQL CheckStatusState / CheckConclusionState / StatusState
      location: packages/cli/src/cli/land-result.ts readLandSnapshot classification
      source: >-
        https://docs.github.com/en/graphql/reference/enums (CheckStatusState
        REQUESTED, QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING;
        CheckConclusionState ACTION_REQUIRED, TIMED_OUT, CANCELLED, FAILURE,
        SUCCESS, NEUTRAL, SKIPPED, STARTUP_FAILURE, STALE; StatusState ERROR,
        EXPECTED, FAILURE, PENDING, SUCCESS)
      gaps: []
    - name: land result values
      location: packages/cli/src/cli/land-result.ts LandResultKind
      source: issue
      gaps: []
    - name: sysexits EX_TEMPFAIL
      location: packages/cli/src/cli/land-result.ts LAND_EXIT_CHECKS_PENDING
      source: >-
        sysexits.h (EX_TEMPFAIL = 75); already used by
        AUTO_UPDATE_RESTART_EXIT_CODE in packages/cli/src/cli/daemon.ts
      gaps: []
---
---
route: claude
design:
  restatedProblem: >-
    `factory land <issue>` (cmdLand in packages/cli/src/cli/index.ts) turns every "left open, not
    merged" outcome into a printed yellow line and a normal return, so a CI-watch timeout
    (CiUnverifiedError / AwaitingCiError / BaseCiPendingError, matched by isCiNotGreen) and a
    confirmed failing check (CiFailedError) both exit 0 and differ only in human text. An external
    orchestrator cannot tell "checks still running, retry later" from "red CI" without scraping
    stdout, and `factory land` has no `--json` contract even though docs/cli-json-schemas.md
    reserves one. This slice adds a structured land result (`merged`, `checks_pending`,
    `checks_failed`, `conflicting`, `closed`), makes the checks-pending case exit 75
    (EX_TEMPFAIL), adds `--json` that prints one final machine-readable line, and documents the
    shape with a generated schema and golden fixture. The CI watch, its timing, `ci.skip`, the
    merge gate and every other exit code stay unchanged.
  approach:
    chosen: >-
      Keep landIssue's control flow; classify its outcome in cmdLand. Add a new module
      packages/cli/src/cli/land-result.ts that owns the result kind, the exit-75 constant, a
      best-effort GraphQL snapshot of the PR (headRefOid, mergeable, pending/failed check names
      from statusCheckRollup) and a builder that produces a landResultJsonSchema-valid object.
      landIssue gains one optional `onPrResolved` callback (so cmdLand knows the PR number for a
      conflict) and throws a new LandNoOpenPrError subclass of LandFailureError (same message,
      same code 1) carrying the branch guesses, so cmdLand can detect an already closed PR via
      latestPrForBranch. The snapshot read only happens with --json, so the default path makes
      no new API calls. Pending throws CliExitError('', 75) and main() skips printing an empty
      message, so human output is byte-identical.
    rejected:
      - option: Thread the CI watch's pending/failed check names and head SHA through every land error class (CiFailedError, CiUnverifiedError, AwaitingCiError, LandConflictError).
        reason: Touches the core CI watch and a dozen throw sites in land-pr.ts and core; far larger blast radius than a post-hoc read for a reporting-only feature.
      - option: Emit the JSON without schemaVersion, exactly as sketched in the issue.
        reason: docs/cli-json-schemas.md treats unversioned output as legacy-only (logs-line); every new envelope is versioned. Adding `schemaVersion` as an extra leading key keeps the issue's keys and order intact and is additive for consumers.
      - option: Add more result values (awaiting_review, gated, failed) so every land path prints JSON.
        reason: The issue fixes the enum to five values; extending the public enum is an API decision for a later slice (recorded in openQuestions).
      - option: Exit 75 only when --json is passed.
        reason: The issue requires exit 75 for pending checks as the distinct signal, independent of --json.
  interfacesTouched:
    - packages/cli/src/cli/land-result.ts (new) — LandResultKind, LAND_EXIT_CHECKS_PENDING, LandSnapshot, readLandSnapshot, buildLandResultJson, formatLandResultLine
    - packages/cli/src/cli/json-contract.ts — new landResultJsonSchema + LandResultJson type
    - packages/cli/src/cli/land-pr.ts — new LandNoOpenPrError extends LandFailureError
    - packages/cli/src/cli/land.ts — landIssue opts.onPrResolved; throws LandNoOpenPrError for "no open PR"
    - packages/cli/src/cli/index.ts — cmdLand opts.json, result classification, exit 75; main() skips console.error for an empty CliExitError message
    - packages/cli/src/cli/program-run-work.ts — `land <issue>` gets `--json`
    - scripts/gen-cli-json-schemas.ts — registers land-result.schema.json
    - packages/cli/schemas/land-result.schema.json (generated)
    - packages/cli/src/cli/__fixtures__/json/land-result.json (golden fixture)
    - docs/cli-json-schemas.md, README.md, docs/runbooks/github-actions-run.md, CHANGELOG.md
  targetTypes:
    - name: LandResultKind
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandSnapshot
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandResultJson
      file: packages/cli/src/cli/json-contract.ts
      kind: added
    - name: LandNoOpenPrError
      file: packages/cli/src/cli/land-pr.ts
      kind: added
    - name: LandFailureError
      file: packages/cli/src/cli/land-pr.ts
      kind: read
    - name: CliExitError
      file: packages/cli/src/cli/errors.ts
      kind: read
  signatures:
    - symbol: readLandSnapshot
      file: packages/cli/src/cli/land-result.ts
      signature: 'export async function readLandSnapshot(octokit: Octokit, owner: string, repoName: string, prNumber: number): Promise<LandSnapshot>'
    - symbol: buildLandResultJson
      file: packages/cli/src/cli/land-result.ts
      signature: 'export function buildLandResultJson(result: LandResultKind, prNumber: number, snapshot: LandSnapshot): LandResultJson'
    - symbol: formatLandResultLine
      file: packages/cli/src/cli/land-result.ts
      signature: 'export function formatLandResultLine(json: LandResultJson): string'
    - symbol: landIssue
      file: packages/cli/src/cli/land.ts
      signature: 'export async function landIssue(issueNum: number, repoRoot: string, ghRepo: string, paths: ReturnType<typeof getFactoryPaths>, octokit: Octokit, skipCI?: boolean, branchPrefix?: string, opts?: { allowGated?: boolean; branch?: string; enforceRisk?: boolean; syncMain?: boolean; holdsLandingSlot?: boolean; rebuildOnConflict?: boolean; signal?: AbortSignal; mergeOverrides?: MergePolicyOverrides; issueless?: boolean; onPrResolved?: (pr: { prNumber: number; branch: string }) => void }): Promise<{ branch: string; prNumber: number }>'
    - symbol: cmdLand
      file: packages/cli/src/cli/index.ts
      signature: 'export async function cmdLand(issueNum: number, opts?: { branchPrefix?: string; allowGated?: boolean; json?: boolean }, deps?: Pick<CliDeps, ConfigLoaderKey | GitOpKey | InternalOpKey | ShellOpKey | ''octokit''>): Promise<void>'
  callGraph:
    - from: cmdLand
      to: landIssue
      note: passes onPrResolved to learn prNumber/branch before any conflict can be thrown
    - from: cmdLand
      to: readLandSnapshot
      note: only when opts.json; reads headSha, mergeable, pending and failed check names for the PR
    - from: cmdLand
      to: latestPrForBranch
      note: on LandNoOpenPrError with --json, finds a closed/merged PR on one of err.branches to report `closed`
    - from: cmdLand
      to: buildLandResultJson
      note: result kind + pr + snapshot -> schema-valid object, printed via formatLandResultLine as the last stdout line
    - from: main
      to: cmdLand
      note: CliExitError code 75 with empty message sets process.exitCode without a stderr line
  behaviorContract:
    - A CI outcome matched by isCiNotGreen (CI-watch timeout, no checks ever registered, base CI pending, land deferred) still prints the same yellow "CI never reached a green verdict — left open, not merged" line but now makes `factory land` exit 75 instead of 0.
    - '`factory land --json` prints, as its final stdout line, one JSON object valid against landResultJsonSchema: {"schemaVersion":1,"result":...,"pr":n,"headSha":string|null,"pending":[...] | "failed":[...],"mergeable":"MERGEABLE"|"CONFLICTING"|"UNKNOWN"}.'
    - A successful merge reports `merged` and exits 0; a confirmed failing check (CiFailedError that is not CiUnverifiedError, including CiInfraError) reports `checks_failed` with a `failed` array and still exits 0; a LandConflictError reports `conflicting` and still exits 3; no open PR but a closed (or merged) PR on the branch reports `closed` and still exits 1.
    - Without --json, stdout and stderr lines are byte-identical to before for every outcome, and no extra GitHub API call is made.
    - Outcomes outside the five results (awaiting review, merge-gated, ambiguous lookup, lookup failure, no PR at all, generic merge failure) keep their exact current output and exit codes and print no JSON line.
  verificationPlan:
    - command: npx vitest run packages/cli/src/cli/land-result.test.ts packages/cli/src/cli/land.json.test.ts packages/cli/src/cli/land.test.ts packages/cli/src/cli/json-contract.test.ts
      passWhen: all tests pass, including the new per-result exit-code and JSON-shape tests
    - command: bash scripts/check-cli-json-schemas.sh
      passWhen: prints "check-cli-json-schemas: OK" (committed land-result.schema.json matches the Zod schema)
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (run by CHECK before SHIP)
  riskBlastRadius: >-
    `factory land` exit code changes from 0 to 75 for the CI-not-green case. scripts/factory-run.sh
    already propagates land's non-zero exit and writes an ::error:: line, so a hosted Actions run
    whose land times out on CI now fails visibly instead of passing silently with the PR open;
    this is intended and documented in the runbook. landIssue's other callers (waitForMerge,
    resume-approved, run-issue --merge, lanes) do not use onPrResolved and still see a
    LandFailureError (LandNoOpenPrError is a subclass with the same message and code), so their
    behaviour is unchanged. A wrong main() change (skipping empty messages) could hide an error
    message only if some caller throws CliExitError(''), which none does today.
  openQuestions:
    - 'Outcomes the issue does not name (awaiting human review, merge-gated exit 4, ambiguous/no PR, lookup failure, generic merge failure exit 5) print no JSON line in this slice; adding result values for them is a follow-up API decision.'
    - 'The JSON line adds a leading "schemaVersion":1 key beyond the issue sketch, to match the versioned-envelope rule in docs/cli-json-schemas.md; all sketched keys and their order are kept.'
    - 'A PR that is already merged when `factory land` runs (no open PR, latest PR merged) reports `closed` with exit 1, because the merge did not happen in this invocation.'
  evidencePlan:
    - kind: fail-to-pass-test
      claim: '`factory land --json` prints a documented final JSON line for merged, checks_pending, checks_failed, conflicting, and closed — each scenario''s last stdout line parses and validates against landResultJsonSchema with the expected `result`'
      test: packages/cli/src/cli/land.json.test.ts "prints a merged result line on a successful merge" "prints a checks_pending result line when CI never reaches a green verdict" "prints a checks_failed result line with failed check names" "prints a conflicting result line on a land conflict" "prints a closed result line when the PR is already closed"
    - kind: fail-to-pass-test
      claim: Checks still pending (including a CI-watch timeout that leaves the PR open) exit 75 and report checks_pending — watchChecks 'timeout' makes cmdLand reject with CliExitError code 75 and main() sets process.exitCode 75 with no stderr line
      test: packages/cli/src/cli/land.json.test.ts "exits 75 when CI never reaches a green verdict" "main sets exit code 75 without printing an error line"
    - kind: fail-to-pass-test
      claim: A successful merge exits 0 and reports merged — cmdLand --json resolves and the last line has result merged, the PR number and pending []
      test: packages/cli/src/cli/land.json.test.ts "prints a merged result line on a successful merge"
    - kind: fail-to-pass-test
      claim: A failing check reports checks_failed and is otherwise handled as today — watchChecks 'failure' still resolves (exit 0), prints the failing-CI line, does not merge, and the JSON line has result checks_failed and a failed array
      test: packages/cli/src/cli/land.json.test.ts "prints a checks_failed result line with failed check names"
    - kind: fail-to-pass-test
      claim: Without --json the human-readable lines stay the same — for merged, failing CI and timeout the captured stdout equals the exact pre-change lines and contains no JSON, and no snapshot GraphQL query is issued
      test: packages/cli/src/cli/land.json.test.ts "keeps human output unchanged and reads no snapshot without --json"
    - kind: fail-to-pass-test
      claim: The shapes are documented in docs/cli-json-schemas.md — the land-result golden fixture validates against the committed generated land-result.schema.json
      test: packages/cli/src/cli/json-contract.test.ts "validates every golden fixture against its committed generated schema"
    - kind: fail-to-pass-test
      claim: Unit tests cover each result and exit code — snapshot parsing maps CheckRun/StatusContext states to pending and failed names, degrades to UNKNOWN/null on error, and the builder emits `failed` only for checks_failed
      test: packages/cli/src/cli/land-result.test.ts "collects pending and failed check names from the status rollup" "returns an unknown snapshot when the read fails" "uses failed instead of pending for checks_failed"
  outline:
    - result: landResultJsonSchema, its generated schema and golden fixture exist and validate
      files:
        - packages/cli/src/cli/json-contract.ts
        - packages/cli/src/cli/json-contract.test.ts
        - packages/cli/src/cli/__fixtures__/json/land-result.json
        - scripts/gen-cli-json-schemas.ts
        - packages/cli/schemas/land-result.schema.json
      automatedChecks:
        - npx vitest run packages/cli/src/cli/json-contract.test.ts
        - bash scripts/check-cli-json-schemas.sh
      manualChecks: []
    - result: land-result.ts reads a PR snapshot and builds a schema-valid result for each of the five kinds
      files:
        - packages/cli/src/cli/land-result.ts
        - packages/cli/src/cli/land-result.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land-result.test.ts
      manualChecks: []
    - result: cmdLand classifies outcomes, exits 75 on pending, prints the JSON line with --json, and keeps human output unchanged
      files:
        - packages/cli/src/cli/land-pr.ts
        - packages/cli/src/cli/land.ts
        - packages/cli/src/cli/index.ts
        - packages/cli/src/cli/program-run-work.ts
        - packages/cli/src/cli/land.test.ts
        - packages/cli/src/cli/land.json.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land.json.test.ts packages/cli/src/cli/land.test.ts
      manualChecks:
        - Run `factory land <N> --json` against a PR whose CI is still running and confirm `echo $?` prints 75 and the last line has "result":"checks_pending"
    - result: Docs and changelog describe the result values, exit 75 and the JSON contract
      files:
        - docs/cli-json-schemas.md
        - README.md
        - docs/runbooks/github-actions-run.md
        - CHANGELOG.md
      automatedChecks:
        - npx prettier --check docs/cli-json-schemas.md README.md docs/runbooks/github-actions-run.md CHANGELOG.md
      manualChecks: []
  edgeInputs:
    - CiUnverifiedError from a watchChecks 'timeout' / no-verdict outcome
    - LandDeferredError (CiUnverifiedError subclass, base kept moving)
    - AwaitingCiError (no check run or status ever registered)
    - BaseCiPendingError (base CI still pending)
    - CiInfraError (CiFailedError subclass, infra rerun failed)
    - plain CiFailedError (confirmed failing check)
    - AwaitingReviewError (risk or review gate)
    - MergeGatedError
    - LandConflictError with and without `rebuild`
    - LandNoOpenPrError where the branch has a closed PR, a merged PR, or no PR at all
    - other LandFailureError (ambiguous lookup code 1, lookup failure code 5, merge failure code 5)
    - VisualProofMissingError and any unknown error (generic code-5 fallthrough)
    - snapshot GraphQL read throwing, returning no pullRequest, or an empty/absent statusCheckRollup
    - mergeable values outside MERGEABLE/CONFLICTING (null or unexpected string)
  behaviorDelta:
    - input: isCiNotGreen error (timeout, LandDeferred, AwaitingCi, BaseCiPending)
      branch: isCiNotGreen
      before: yellow "CI never reached a green verdict" line, exit 0
      after: same line, exit 75; with --json also a checks_pending line
      verdict: better
    - input: CiFailedError / CiInfraError
      branch: instanceof CiFailedError
      before: yellow "failing CI check" line, exit 0
      after: same line, exit 0; with --json also a checks_failed line
      verdict: same
    - input: successful merge
      branch: success
      before: green "Landed PR" line, exit 0
      after: same line, exit 0; with --json also a merged line
      verdict: same
    - input: LandConflictError
      branch: instanceof LandConflictError
      before: stderr message, exit 3
      after: same, exit 3; with --json a conflicting line on stdout first
      verdict: same
    - input: LandNoOpenPrError (branch has a closed or merged PR)
      branch: no open PR
      before: stderr "no open PR" message, exit 1
      after: same message, exit 1; with --json a closed line on stdout first
      verdict: same
    - input: LandNoOpenPrError (no PR on any guessed branch) or latestPrForBranch throws
      branch: no open PR
      before: stderr "no open PR" message, exit 1
      after: unchanged, no JSON line
      verdict: same
    - input: AwaitingReviewError, MergeGatedError, other LandFailureError, VisualProofMissingError, unknown error
      branch: existing branches and generic fallthrough
      before: current lines and exit codes (0, 4, err.code, 5)
      after: unchanged, no JSON line
      verdict: same
    - input: snapshot read fails or mergeable is null/unknown
      branch: readLandSnapshot catch / mergeable normalisation
      before: n/a (no snapshot)
      after: headSha null (or AwaitingCiError.headSha), mergeable UNKNOWN, empty arrays; result and exit code unaffected
      verdict: better
    - input: GitHub Actions factory-run.sh running `factory land` whose CI watch times out
      branch: rc != 0 in factory-run.sh
      before: job passed with the PR left open
      after: job fails with exit 75 and an ::error:: line naming the land exit
      verdict: better
  externalLists:
    - name: GitHub GraphQL MergeableState enum
      location: packages/cli/src/cli/json-contract.ts landResultJsonSchema.mergeable
      source: https://docs.github.com/en/graphql/reference/enums#mergeablestate (CONFLICTING, MERGEABLE, UNKNOWN)
      gaps: []
    - name: GitHub GraphQL CheckStatusState / CheckConclusionState / StatusState
      location: packages/cli/src/cli/land-result.ts readLandSnapshot classification
      source: https://docs.github.com/en/graphql/reference/enums (CheckStatusState REQUESTED, QUEUED, IN_PROGRESS, COMPLETED, WAITING, PENDING; CheckConclusionState ACTION_REQUIRED, TIMED_OUT, CANCELLED, FAILURE, SUCCESS, NEUTRAL, SKIPPED, STARTUP_FAILURE, STALE; StatusState ERROR, EXPECTED, FAILURE, PENDING, SUCCESS)
      gaps: []
    - name: land result values
      location: packages/cli/src/cli/land-result.ts LandResultKind
      source: issue #4306 (merged, checks_pending, checks_failed, conflicting, closed)
      gaps: []
    - name: sysexits EX_TEMPFAIL
      location: packages/cli/src/cli/land-result.ts LAND_EXIT_CHECKS_PENDING
      source: sysexits.h (EX_TEMPFAIL = 75); already used by AUTO_UPDATE_RESTART_EXIT_CODE in packages/cli/src/cli/daemon.ts
      gaps: []
---
# Spec: `factory land` reports a structured result and a distinct exit code when checks are still pending (#4306)

## Goal

Give orchestrators a machine-readable `factory land` outcome. Add a structured land result
(`merged`, `checks_pending`, `checks_failed`, `conflicting`, `closed`). Exit 75 (`EX_TEMPFAIL`)
when checks never reached a green verdict and the PR was left open. Add `--json`, which prints
one final JSON line, and document it with a generated schema and golden fixture in
`docs/cli-json-schemas.md`. The human lines, the CI watch, its timing, `ci.skip` and every other
exit code stay as they are. No-wait mode is not part of this slice.

## Files / approach

### 1. `packages/cli/src/cli/json-contract.ts`: add the schema

```ts
const landResultBase = {
  schemaVersion: z.literal(1),
  pr: z.number().int(),
  headSha: z.string().nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
};
export const landResultJsonSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('checks_failed'), ...landResultBase, failed: z.array(z.string()) }),
  z.object({
    result: z.enum(['merged', 'checks_pending', 'conflicting', 'closed']),
    ...landResultBase,
    pending: z.array(z.string()),
  }),
]);
export type LandResultJson = z.infer<typeof landResultJsonSchema>;
```

(If zod 4's `discriminatedUnion` rejects an enum discriminator, use `z.union` with the same two
objects.) The schema and the type must be exported and used. Knip flags unused exports.

- `scripts/gen-cli-json-schemas.ts`: import `landResultJsonSchema` and add
  `['land-result.schema.json', landResultJsonSchema]` to `schemas`.
- Generate `packages/cli/schemas/land-result.schema.json` with
  `npx tsx scripts/gen-cli-json-schemas.ts packages/cli/schemas`. Never hand-write it.
- Golden fixture `packages/cli/src/cli/__fixtures__/json/land-result.json`, for example
  `{"schemaVersion":1,"result":"checks_pending","pr":7,"headSha":"2222222222222222222222222222222222222222","pending":["ci"],"mergeable":"MERGEABLE"}`
  (Prettier-formatted).
- `packages/cli/src/cli/json-contract.test.ts`: add
  `['land-result.schema.json', 'land-result.json', landResultJsonSchema]` to `generatedContracts`.
  Add a small test that a `checks_failed` object carrying `pending` and no `failed` is rejected.

### 2. New `packages/cli/src/cli/land-result.ts`

- `export type LandResultKind = LandResultJson['result'];`
- `export const LAND_EXIT_CHECKS_PENDING = 75;`
- `export type LandSnapshot = { headSha: string | null; mergeable: LandResultJson['mergeable']; pending: string[]; failed: string[] };`
- `readLandSnapshot(octokit, owner, repoName, prNumber)`: one `octokit.graphql` query, named
  `query LandResultSnapshot(...)`, reading
  `repository.pullRequest { headRefOid mergeable commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } } }`.
  It classifies:
  - CheckRun `status !== 'COMPLETED'`: pending.
  - CheckRun conclusion in `FAILURE | TIMED_OUT | CANCELLED | ACTION_REQUIRED | STARTUP_FAILURE`: failed.
  - StatusContext `PENDING | EXPECTED`: pending. `FAILURE | ERROR`: failed.

  Names are deduped and sorted. `mergeable` is normalised: `MERGEABLE` and `CONFLICTING` pass
  through, anything else becomes `UNKNOWN`. Any throw or missing node returns
  `{ headSha: null, mergeable: 'UNKNOWN', pending: [], failed: [] }`. It never throws.
- `buildLandResultJson(result, prNumber, snapshot)` returns `{ schemaVersion: 1, result, pr, headSha, failed }`
  for `checks_failed`, and `{ schemaVersion: 1, result, pr, headSha, pending, mergeable }` for
  the others. Put `mergeable` last in both. `merged` and `closed` always report `pending: []`.
  Validate the object with `landResultJsonSchema.parse`.
- `formatLandResultLine(json)` returns `JSON.stringify(json)`.

### 3. `packages/cli/src/cli/land-pr.ts`

Add, next to `LandFailureError`:

```ts
export class LandNoOpenPrError extends LandFailureError {
  constructor(message: string, readonly branches: string[]) { super(message, 1); }
}
```

### 4. `packages/cli/src/cli/land.ts`: `landIssue`

- Add `onPrResolved?: (pr: { prNumber: number; branch: string }) => void` to `opts`. Call it
  right after `const prNumber = lookup.prNumber;`.
- Replace the `lookup.status !== 'found'` throw with
  `throw new LandNoOpenPrError(\`no open PR for issue #${issueNum} (${guessedBranch})\`, guesses)`.
  Keep the message and the logged event exactly as they are.

No other control-flow change. waitForMerge and the other callers are untouched.

### 5. `packages/cli/src/cli/index.ts`

- `cmdLand` opts gains `json?: boolean`. Keep a local `let pr: { prNumber: number; branch: string } | undefined`
  and pass `onPrResolved: (p) => { pr = p; }` to `landIssue`. Add a helper inside `cmdLand`:

  ```ts
  const emit = async (result: LandResultKind, prNumber: number, fallbackHeadSha?: string) => {
    if (!opts.json) return;
    const snap = await readLandSnapshot(octokit, owner, repoName, prNumber);
    console.log(formatLandResultLine(buildLandResultJson(result, prNumber, { ...snap, headSha: snap.headSha ?? fallbackHeadSha ?? null })));
  };
  ```

  Here `[owner, repoName] = ghRepo.split('/')`.
- Success: keep the green line, then `await emit('merged', result.prNumber)`.
- `AwaitingReviewError`: unchanged, no JSON.
- `isCiNotGreen(err)`: keep the yellow line. Then call
  `await emit('checks_pending', err.prNumber, err instanceof AwaitingCiError ? err.headSha : undefined)`
  and `throw new CliExitError('', LAND_EXIT_CHECKS_PENDING)`. Import `AwaitingCiError` from
  `./land-pr.js` if it is not imported already.
- `CiFailedError` (after the isCiNotGreen check, as today): keep the yellow line,
  `await emit('checks_failed', err.prNumber)`, return (exit 0).
- `MergeGatedError`: unchanged.
- `LandConflictError`: `const n = err.rebuild?.prNumber ?? pr?.prNumber; if (n !== undefined) await emit('conflicting', n);`
  then throw the same `CliExitError(..., 3)`.
- `LandNoOpenPrError`, checked before the generic `LandFailureError` branch: when `opts.json`,
  try each `err.branches` with `latestPrForBranch(octokit, owner, repoName, b)` (imported from
  `./land.js` or `./land-merged.js`). Use the first non-null result and wrap it in try/catch,
  where a throw means no JSON. When a PR is found, `await emit('closed', found.number)`. Then
  throw the same `CliExitError(\`factory: ${err.message}\`, 1)`.
- All other branches stay unchanged.
- In `main()`'s `catch (err instanceof CliExitError)`, print with `console.error` only when
  `err.message !== ''`. Always set `process.exitCode = err.code`.

### 6. `packages/cli/src/cli/program-run-work.ts`

Add `.option('--json', 'Print a final JSON result line (merged, checks_pending, checks_failed, conflicting, closed); see docs/cli-json-schemas.md')`
to `land <issue>`. Also add one sentence to the description, keeping the existing text:
"exits 75 when checks are still pending". Opts already flow through to `cmdLand`.

### 7. Docs and changelog

- `docs/cli-json-schemas.md`:
  - Add a table row for `factory land --json` (final stdout line) → `land-result.schema.json` /
    `land-result.json`. Version cell: `schemaVersion` is `1`; `result` is one of the five;
    `failed` replaces `pending` for `checks_failed`; `headSha` is null when unreadable;
    `mergeable` is `MERGEABLE`, `CONFLICTING` or `UNKNOWN`.
  - Update the counts in the intro sentences.
  - Replace "Future JSON support for `land` (#2279)…" so that it no longer lists `land`.
  - Add a short "factory land results" subsection with a result → exit-code table:
    - `merged` 0
    - `checks_pending` 75
    - `checks_failed` 0
    - `conflicting` 3
    - `closed` 1

    Note that awaiting review, gated (4), lookup failures and other failures print no JSON line
    and keep their current exit codes.
- `README.md`: on the `factory land <N>` CLI line (line ~153), mention `--json` and exit 75 when
  checks are still pending.
- `docs/runbooks/github-actions-run.md`, Merging section: a land whose CI never reaches green
  now exits 75, so the job fails with land's exit code instead of passing with the PR open.
- `CHANGELOG.md` under `## Unreleased`, `### Changed`:
  "`factory land` exits 75 when checks are still pending and gains `--json`, a final result line
  (`merged`, `checks_pending`, `checks_failed`, `conflicting`, `closed`) (#4306)".

## Tests

- New `packages/cli/src/cli/land-result.test.ts` covers the pure module:
  - "collects pending and failed check names from the status rollup": a mixed CheckRun and
    StatusContext rollup gives sorted, deduped names.
  - "returns an unknown snapshot when the read fails": graphql rejects, or returns no pullRequest.
  - "normalises an unexpected mergeable value to UNKNOWN".
  - "uses failed instead of pending for checks_failed".
  - "builds a schema-valid object for every result kind": loop over the five kinds and
    `landResultJsonSchema.parse`.
- New `packages/cli/src/cli/land.json.test.ts`: copy the harness pattern from `land.test.ts`
  (fakes `h`, `inertConfigLoaders`, `inertGitOps`, `makeInternalFakes`, `defaultOctokit`,
  `runMain`). Extend the fake `graphql` to answer `LandResultSnapshot` with a `headRefOid`,
  `mergeable` and a rollup. Tests:
  - "prints a merged result line on a successful merge": resolves, and the last `console.log`
    line parses to `result: 'merged'`, `pr: 7`, `pending: []`.
  - "prints a checks_pending result line when CI never reaches a green verdict": `watchChecks`
    `'timeout'` with `{ json: true }` rejects `{ code: 75 }`, and the last log line has
    `result: 'checks_pending'` and the pending names.
  - "exits 75 when CI never reaches a green verdict": the same without --json rejects
    `{ code: 75 }` and still logs "left open, not merged".
  - "main sets exit code 75 without printing an error line": `runMain('land', '5')` with a
    timeout returns code 75, and `console.error` is not called with a non-empty message.
  - "prints a checks_failed result line with failed check names": `watchChecks` `'failure'`
    resolves, there is no merge, and the last line has `result: 'checks_failed'` and a `failed`
    array.
  - "prints a conflicting result line on a land conflict": reuse the conflict setup from
    `land.test.ts` "exits 3 on a land sync conflict". It rejects `{ code: 3 }` and the last log
    line has `result: 'conflicting'`.
  - "prints a closed result line when the PR is already closed": `pulls.list` returns no open
    PR for the lookup, but returns a closed PR for the `state: 'all'` query. It rejects
    `{ code: 1 }` and the last line has `result: 'closed'`.
  - "keeps human output unchanged and reads no snapshot without --json": for merged, failure
    and timeout, the logged lines equal the exact pre-change strings, no line starts with `{`,
    and `graphql` never receives `LandResultSnapshot`.

  Every JSON line is validated with `landResultJsonSchema.parse`.
- Update `packages/cli/src/cli/land.test.ts`: the test "cmdLand(5) resolves cleanly … CI never
  reaches a green verdict (timeout)" changes as the issue requires. It now asserts
  `rejects.toMatchObject({ code: 75 })` and keeps every other assertion, including the
  left-open line, no merge, cleanup and the `ci-failed` event. Rename it to "… exits 75 and
  leaves the PR open …". Do not delete it.
- `json-contract.test.ts`: add the new `generatedContracts` row and the rejection test.

Command:
`npx vitest run packages/cli/src/cli/land-result.test.ts packages/cli/src/cli/land.json.test.ts packages/cli/src/cli/land.test.ts packages/cli/src/cli/json-contract.test.ts && bash scripts/check-cli-json-schemas.sh`

## Constitution compliance

- **Verify gate:** BUILD runs the focused command above. CHECK runs
  `bash scripts/verify.sh --no-e2e`, which covers format, build, type-check, oxlint
  `--deny-warnings`, knip, coverage and the schema check. All new exports are used, so knip
  stays clean.
- **Coverage:** new code is fully unit-tested. No threshold is lowered. If the ratchet reports a
  rise, raise it in the same change.
- **No skipped or deleted tests:** the timeout test in `land.test.ts` is updated to the new
  required exit code, not removed. No inline lint disables.
- **No comments:** none added (ADR-0177). Do not copy the header comments from `land.test.ts`
  into the new test file. `comments-baseline.json` does not grow.
- **Tests:** colocated tests for every changed source file:
  - `land-result.test.ts` (new)
  - `land.json.test.ts` and `land.test.ts` for `land.ts` and `cmdLand`
  - `json-contract.test.ts`
  - the `program-run-work.ts` option is exercised through `runMain`

  The new tests fail before the change: no `--json`, exit 0 on timeout.
- **Architecture:** all changes stay in `packages/cli` and import core only through the
  published `@on-par/factory-core` and `/internal` paths. Relative imports use `.js`. No model
  ids. Terms follow CONTEXT.md (land, park, PR left open).
- **ADRs:** ADR-0170 and ADR-0171 (land merges only CI-verified heads, base CI gates merges)
  are untouched. The result only reports after the existing gates decide. ADR-0175's
  land-deferred stays a non-park outcome and is reported as `checks_pending`. ADR-0160 does not
  apply because no config validation changes. ADR-0178's land credential is reused and no new
  write calls are added (the snapshot is a read). No new ADR is planned.
- **Docs and release hygiene:** a CHANGELOG `## Unreleased` / `### Changed` entry ending in
  (#4306). README, `docs/cli-json-schemas.md` and the Actions runbook are updated. The schema is
  generated, not hand-edited. No `package.json` version edits.
  `docs/config.example.yaml` is untouched.
- **Safety:** no shell built from inputs. The snapshot uses parameterised GraphQL variables. No
  secrets in output. The CI gate, `ci.skip`, merge gates and run locks are unchanged. Exit 75
  makes a not-green land louder in Actions, never quieter.

## Non-goals

- `--no-wait`, `land.waitForCi`, or any single-read / non-blocking land path.
- Wiring those flags through `factory land <issue>` (later slice).
- `resume-approved --json` (#2279).
- Changing the meaning of `ci.skip`, CI watch timing, or weakening the CI gate.
- New result values for awaiting-review, gated or lookup-failure outcomes.
