---
route: claude
design:
  restatedProblem: >-
    `factory land <issue>` (cmdLand in packages/cli/src/cli/index.ts) ends with a printed yellow line and exit 0
    for two different "PR left open, not merged" outcomes: checks still pending (isCiNotGreen: CiUnverifiedError
    from a CI-watch timeout, an unreadable watch, a moved head or a land deferral, plus AwaitingCiError and
    BaseCiPendingError) and a confirmed failing check (CiFailedError / CiInfraError). An orchestrator can only
    tell them apart by parsing human text, and `factory land` has no `--json` contract even though
    docs/cli-json-schemas.md reserves one. This slice adds a structured land result with five values
    (merged, checks_pending, checks_failed, conflicting, closed), makes checks-pending exit 75 (EX_TEMPFAIL),
    adds `factory land --json` that prints that result as the final stdout line, and documents the schema with
    a generated schema file and golden fixture. Every other exit code, every human-readable line, the CI watch,
    its timing, ci.skip and the CI gate stay unchanged. No-wait mode is not part of this slice.
  approach:
    chosen: >-
      Keep cmdLand thin (index.ts has only ~30 lines of max-lines headroom) and put the logic in a new module
      packages/cli/src/cli/land-result.ts. landResultKind maps the land outcome to a result kind. readLandResult
      does a best-effort read of the PR (pulls.get gives the head sha and mergeable) and of its head checks
      (check runs plus commit statuses) and builds the JSON object. printLandResult writes the JSON line when
      --json is set. The zod schema goes in a new packages/cli/src/cli/land-result-contract.ts, because
      json-contract.ts is at 492/500 lines; job-status-contract.ts is the precedent. landIssue gets one optional
      `onPrResolved` callback so cmdLand knows the PR number on every path, including LandConflictError, which
      carries no PR number. The no-open-PR throw becomes LandNoOpenPrError, a LandFailureError subclass with the
      same message and code 1 that carries the guessed branches. With --json, cmdLand then looks for a closed PR
      on those branches to report `closed`. For checks pending, cmdLand prints the same yellow line, then throws
      CliExitError('', 75). The main() CliExitError handler skips console.error for an empty message, so no extra
      human output appears.
    rejected:
      - option: Put the dispatch, the PR and check reads, and the JSON building inline in cmdLand in index.ts
        reason: index.ts is at 4426 lines against a 4456 max-lines ceiling, and the logic would be hard to unit-test.
      - option: Add the landResultJsonSchema to json-contract.ts
        reason: json-contract.ts is at 492 lines (500 limit). A separate contract file follows the job-status-contract.ts precedent.
      - option: Thread pending/failed check names out of watchChecks / CiFailedError
        reason: That changes core's CI-watch API and every error constructor. One read after the outcome is simpler, affects only the --json path, and cannot change the merge decision.
      - option: Invent extra result values (awaiting_review, gated, error) for outcomes outside the five
        reason: 'The issue fixes the enum at five values. Other outcomes keep their exit codes and print no result line, and the doc says so. #2279 can extend the enum additively.'
      - option: Exit 75 only with --json
        reason: The issue requires exit 75 for checks pending, independent of --json.
  interfacesTouched:
    - packages/cli/src/cli/land-result.ts (new) — LandResultKind, LAND_CHECKS_PENDING_EXIT_CODE, LandNoOpenPrError, landResultKind, readLandResult, printLandResult
    - packages/cli/src/cli/land-result-contract.ts (new) — landResultJsonSchema, LandResultJson
    - packages/cli/src/cli/land.ts — landIssue opts gains onPrResolved; no-open-PR throw becomes LandNoOpenPrError (same message, code 1)
    - packages/cli/src/cli/index.ts — cmdLand opts gains json; prints the result line; checks pending exits 75; main() skips empty CliExitError messages
    - packages/cli/src/cli/program-run-work.ts — `land <issue>` gains `--json`
    - scripts/gen-cli-json-schemas.ts — adds land-result.schema.json
    - packages/cli/schemas/land-result.schema.json (new, generated)
    - packages/cli/src/cli/__fixtures__/json/land-result.json (new golden fixture)
    - packages/cli/src/cli/json-contract.test.ts — adds the land-result row to generatedContracts
    - docs/cli-json-schemas.md, docs/runbooks/github-actions-run.md, CHANGELOG.md
  targetTypes:
    - name: LandResultJson
      file: packages/cli/src/cli/land-result-contract.ts
      kind: added
    - name: LandResultKind
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandNoOpenPrError
      file: packages/cli/src/cli/land-result.ts
      kind: added
    - name: LandFailureError
      file: packages/cli/src/cli/land-pr.ts
      kind: read
    - name: CiFailedError
      file: packages/cli/src/cli/land-errors.ts
      kind: read
    - name: CliExitError
      file: packages/cli/src/cli/errors.ts
      kind: read
  signatures:
    - symbol: landResultKind
      file: packages/cli/src/cli/land-result.ts
      signature: 'export function landResultKind(err: unknown): LandResultKind | undefined'
    - symbol: readLandResult
      file: packages/cli/src/cli/land-result.ts
      signature: 'export async function readLandResult(octokit: Octokit, ghRepo: string, result: LandResultKind, prNumber: number): Promise<LandResultJson>'
    - symbol: printLandResult
      file: packages/cli/src/cli/land-result.ts
      signature: 'export async function printLandResult(opts: { json: boolean; octokit: Octokit; ghRepo: string; prNumber?: number; error?: unknown; write?: (line: string) => void }): Promise<void>'
    - symbol: landIssue
      file: packages/cli/src/cli/land.ts
      signature: 'export async function landIssue(issueNum: number, repoRoot: string, ghRepo: string, paths: ReturnType<typeof getFactoryPaths>, octokit: Octokit, skipCI?: boolean, branchPrefix?: string, opts?: { allowGated?: boolean; branch?: string; enforceRisk?: boolean; syncMain?: boolean; holdsLandingSlot?: boolean; rebuildOnConflict?: boolean; signal?: AbortSignal; mergeOverrides?: MergePolicyOverrides; issueless?: boolean; onPrResolved?: (pr: { prNumber: number; branch: string }) => void }): Promise<{ branch: string; prNumber: number }>'
    - symbol: cmdLand
      file: packages/cli/src/cli/index.ts
      signature: 'export async function cmdLand(issueNum: number, opts?: { branchPrefix?: string; allowGated?: boolean; json?: boolean }, deps?: Pick<CliDeps, ConfigLoaderKey | GitOpKey | InternalOpKey | ShellOpKey | ''octokit''>): Promise<void>'
  callGraph:
    - from: cmdLand
      to: landIssue
      note: passes onPrResolved to capture prNumber/branch; receives the merged result or the thrown land error
    - from: cmdLand
      to: printLandResult
      note: on every outcome passes json flag, octokit, ghRepo, the captured prNumber and the error (undefined on merge)
    - from: printLandResult
      to: landResultKind
      note: maps the error (or none) to merged | checks_pending | checks_failed | conflicting | undefined
    - from: printLandResult
      to: latestPrForBranch
      note: only for LandNoOpenPrError with --json; tries each guessed branch, and a PR that is found becomes result closed
    - from: printLandResult
      to: readLandResult
      note: builds the JSON object for the kind and PR number
    - from: readLandResult
      to: listAllCheckRuns
      note: check runs on the head sha, giving pending names (status != completed) and failed names (completed, conclusion not success/neutral/skipped)
    - from: landIssue
      to: LandNoOpenPrError
      note: replaces the plain LandFailureError for "no open PR" with the same message and code 1, carrying the guessed branches
  behaviorContract:
    - '`factory land <n>` exits 75 when checks are still pending (any isCiNotGreen error: CI-watch timeout, unreadable watch, head moved past the verified sha, land deferral, AwaitingCiError, BaseCiPendingError); it printed the same yellow line and exited 0 before.'
    - '`factory land <n> --json` ends stdout with one JSON line {"schemaVersion":1,"result":...,"pr":n,"headSha":...,"mergeable":...} for merged, checks_pending (plus "pending":[...]), checks_failed (plus "failed":[...]), conflicting and closed.'
    - A merge still exits 0; a failing check still prints the same yellow line and exits 0; a conflict still exits 3; no open PR still exits 1 with the same stderr message (it reports closed with --json when a closed PR exists for the branch).
    - Without --json, stdout and stderr lines are byte-for-byte unchanged, and the checks-pending exit adds no stderr line.
    - The land JSON contract has a generated schema (packages/cli/schemas/land-result.schema.json), a golden fixture and a row in docs/cli-json-schemas.md.
    - Outcomes outside the five (awaiting review, merge-gated exit 4, PR lookup failure, generic exit 5, no PR at all) print no result line and keep their exit codes.
  verificationPlan:
    - command: npx vitest run packages/cli/src/cli/land-result.test.ts packages/cli/src/cli/land-result-contract.test.ts packages/cli/src/cli/land-json.test.ts packages/cli/src/cli/land.test.ts packages/cli/src/cli/json-contract.test.ts
      passWhen: all tests pass
    - command: bash scripts/check-cli-json-schemas.sh
      passWhen: 'prints "check-cli-json-schemas: OK" (committed land-result.schema.json matches the zod definition)'
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (CHECK runs this full gate)
  riskBlastRadius: >-
    Only the `factory land` CLI command. landIssue's merge path is unchanged apart from an optional callback and a
    LandFailureError subclass that keeps the same message and code, so lanes, waitForMerge and resume-approved
    behave the same. The visible change is exit 75 on checks pending. scripts/factory-run.sh (FACTORY_MERGE=1 path)
    now writes "::error::factory land N exited 75" and fails the job, where it used to exit 0 with the PR unmerged.
    scripts/auto-merge-sweep.sh now logs "FAILED to land ... (exit 75)", where it used to log "landed". Both are
    more honest, and both are documented. If the JSON read is wrong, only the --json line is wrong: the read is
    best-effort and can never change the merge decision or the exit code.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: factory land --json prints a documented final JSON line for merged, checks_pending, checks_failed, conflicting and closed — each scenario's last stdout line parses and validates against landResultJsonSchema with the expected result value
      test: packages/cli/src/cli/land-json.test.ts "prints a merged result line and exits 0" "prints a checks_pending result line with pending check names and exits 75 on a CI-watch timeout" "prints a checks_failed result line with failed check names and keeps exit 0" "prints a conflicting result line and keeps exit 3" "prints a closed result line and keeps exit 1 when the branch PR is closed"
    - kind: fail-to-pass-test
      claim: Checks still pending (including a CI-watch timeout that leaves the PR open) exit 75 and report checks_pending — a watchChecks 'timeout' outcome and an AwaitingCiError both make cmdLand reject with CliExitError code 75, with the yellow line unchanged and no merge
      test: packages/cli/src/cli/land.test.ts "cmdLand(5) exits 75 and leaves the PR open when CI never reaches a green verdict (timeout)" packages/cli/src/cli/land-result.test.ts "maps every CI-not-green error to checks_pending"
    - kind: fail-to-pass-test
      claim: A successful merge exits 0 and reports merged — cmdLand resolves, prints the green Landed line, and the --json line has result merged and the PR number
      test: packages/cli/src/cli/land-json.test.ts "prints a merged result line and exits 0"
    - kind: fail-to-pass-test
      claim: A failing check reports checks_failed and is otherwise handled as today — a watchChecks 'failure' outcome still resolves (exit 0), prints the same failing-CI yellow line and cleans up the worktree, and the --json line is checks_failed with failed names from the head check runs
      test: packages/cli/src/cli/land-json.test.ts "prints a checks_failed result line with failed check names and keeps exit 0" packages/cli/src/cli/land-result.test.ts "maps CiFailedError and CiInfraError to checks_failed"
    - kind: fail-to-pass-test
      claim: Without --json, the human-readable lines stay the same — for merged, timeout, failure and conflict, no stdout line starts with '{' and the human lines equal today's exact strings, and the checks-pending exit prints nothing to stderr
      test: packages/cli/src/cli/land-json.test.ts "prints no JSON line and unchanged human lines without --json"
    - kind: command
      claim: The shapes are documented in docs/cli-json-schemas.md — the table has a factory land --json row that links land-result.schema.json and the fixture, and the committed schema matches the zod definition
      command: bash scripts/check-cli-json-schemas.sh && grep -F 'factory land --json' docs/cli-json-schemas.md
      passWhen: the schema check prints OK and the grep finds the land row that names land-result.schema.json
      expect:
        exitCode: 0
        stdoutContains:
          - 'check-cli-json-schemas: OK'
          - land-result.schema.json
    - kind: fail-to-pass-test
      claim: Unit tests cover each result and exit code — landResultKind maps each error class to its result, readLandResult builds pending/failed/mergeable correctly and degrades on read failure, and printLandResult reports closed via a closed branch PR
      test: packages/cli/src/cli/land-result.test.ts "maps a successful land to merged" "maps every CI-not-green error to checks_pending" "maps CiFailedError and CiInfraError to checks_failed" "maps LandConflictError to conflicting" "returns undefined for outcomes outside the five results" "lists pending and failed check names from check runs and commit statuses" "maps mergeable true, false and null to MERGEABLE, CONFLICTING and UNKNOWN" "falls back to a null headSha, UNKNOWN and empty lists when the reads fail" "reports closed for LandNoOpenPrError when a closed PR exists on a guessed branch" "prints nothing when json is false"
  outline:
    - result: land-result contract exists, its schema is generated and committed, and the golden fixture validates
      files:
        - packages/cli/src/cli/land-result-contract.ts
        - packages/cli/src/cli/land-result-contract.test.ts
        - scripts/gen-cli-json-schemas.ts
        - packages/cli/schemas/land-result.schema.json
        - packages/cli/src/cli/__fixtures__/json/land-result.json
        - packages/cli/src/cli/json-contract.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land-result-contract.test.ts packages/cli/src/cli/json-contract.test.ts
        - bash scripts/check-cli-json-schemas.sh
      manualChecks: []
    - result: land-result.ts classifies outcomes and builds or prints the JSON line, with unit tests for every kind
      files:
        - packages/cli/src/cli/land-result.ts
        - packages/cli/src/cli/land-result.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land-result.test.ts
      manualChecks: []
    - result: factory land --json prints the line, checks pending exits 75, and other exit codes and human lines are unchanged
      files:
        - packages/cli/src/cli/land.ts
        - packages/cli/src/cli/index.ts
        - packages/cli/src/cli/program-run-work.ts
        - packages/cli/src/cli/land.test.ts
        - packages/cli/src/cli/land-json.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli/land-json.test.ts packages/cli/src/cli/land.test.ts
      manualChecks:
        - Run `factory land <n> --json` on a PR with CI still running and check that the last stdout line is checks_pending and `echo $?` prints 75
    - result: docs and changelog describe the contract and exit 75
      files:
        - docs/cli-json-schemas.md
        - docs/runbooks/github-actions-run.md
        - CHANGELOG.md
      automatedChecks:
        - bash scripts/verify.sh --no-e2e
      manualChecks: []
  edgeInputs:
    - land error undefined (merge succeeded)
    - CiUnverifiedError from a CI-watch timeout with some CI signal
    - CiUnverifiedError from a watch API failure (pulls.get / watch threw)
    - CiUnverifiedError when the head moved past the CI-verified sha
    - LandDeferredError (CiUnverifiedError subclass, base kept moving)
    - AwaitingCiError (no CI registered by the deadline)
    - BaseCiPendingError (base hosted CI pending)
    - CiFailedError (confirmed failing check)
    - CiInfraError (CiFailedError subclass)
    - LandConflictError with and without rebuild
    - LandNoOpenPrError when a closed or merged PR exists on a guessed branch
    - LandNoOpenPrError when no PR exists at all, or when the closed-PR lookup throws
    - other LandFailureError (ambiguous lookup code 1, PR lookup failure code 5, merge failed code 5)
    - MergeGatedError (exit 4)
    - AwaitingReviewError (exit 0)
    - VisualProofMissingError and any unknown error (generic exit 5)
    - pulls.get returning mergeable null, true or false, or throwing
    - check runs with an empty list, a null name, status queued or in_progress, conclusion null, an unknown conclusion string, or a listing that throws
  behaviorDelta:
    - input: merge succeeded
      branch: success path
      before: green Landed line, exit 0
      after: same; with --json a final merged line
      verdict: same
    - input: isCiNotGreen error (timeout, watch failure, head moved, LandDeferredError, AwaitingCiError, BaseCiPendingError)
      branch: CI-not-green branch
      before: yellow "CI never reached a green verdict" line, exit 0
      after: same yellow line, exit 75 with no extra stderr line; with --json a final checks_pending line
      verdict: better
    - input: CiFailedError / CiInfraError
      branch: failing-check branch
      before: yellow "has a failing CI check" line, exit 0
      after: same line and exit 0; with --json a final checks_failed line
      verdict: same
    - input: LandConflictError
      branch: conflict branch
      before: 'stderr "factory: <message>", exit 3'
      after: same; with --json a conflicting line on stdout before the throw
      verdict: same
    - input: no open PR (LandNoOpenPrError), closed PR exists
      branch: LandFailureError branch
      before: 'stderr "factory: no open PR for issue #n (branch)", exit 1'
      after: same message and exit 1; with --json a closed line naming the closed PR
      verdict: same
    - input: no open PR and no PR at all, or the closed-PR lookup throws
      branch: LandFailureError branch
      before: exit 1 with the message
      after: same; no JSON line
      verdict: same
    - input: MergeGatedError, AwaitingReviewError, other LandFailureError, unknown error
      branch: existing branches
      before: exit 4 / exit 0 with yellow line / err.code / exit 5
      after: unchanged; no JSON line (documented)
      verdict: same
    - input: main() handler receives CliExitError with an empty message
      branch: CliExitError handler
      before: printed an empty red line to stderr (no caller used an empty message)
      after: sets process.exitCode and prints nothing
      verdict: same
    - input: scripts/factory-run.sh FACTORY_MERGE=1 land with CI still pending
      branch: rc != 0 branch
      before: land exited 0 and the job passed with the PR unmerged
      after: 'land exits 75 and the job writes ::error:: "factory land N exited 75" and fails'
      verdict: better
    - input: scripts/auto-merge-sweep.sh land with CI still pending
      branch: land failure branch
      before: 'logged "landed #n" although the PR was not merged'
      after: 'logs "FAILED to land #n ... (exit 75)"; the next sweep retries as before'
      verdict: better
  externalLists:
    - name: result enum (merged, checks_pending, checks_failed, conflicting, closed)
      location: packages/cli/src/cli/land-result-contract.ts landResultJsonSchema
      source: 'issue #4306 Behaviour section (contract from #4303)'
      gaps: []
    - name: GitHub MergeableState values (MERGEABLE, CONFLICTING, UNKNOWN), mapped from REST pulls.get mergeable true/false/null
      location: packages/cli/src/cli/land-result.ts readLandResult
      source: GitHub GraphQL MergeableState enum and REST "Get a pull request" docs (mergeable boolean or null while computing)
      gaps: []
    - name: check run status (queued, in_progress, completed, waiting, requested, pending) and conclusion (success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, startup_failure)
      location: packages/cli/src/cli/land-result.ts readLandResult
      source: GitHub REST checks API docs. Passing set success/neutral/skipped matches the land gate in docs/status.md ("skipped or neutral counts as passing"); anything else completed counts as failed
      gaps: []
    - name: commit status state (error, failure, pending, success)
      location: packages/cli/src/cli/land-result.ts readLandResult
      source: GitHub REST "Get the combined status for a specific reference" docs
      gaps: []
    - name: sysexits EX_TEMPFAIL = 75
      location: packages/cli/src/cli/land-result.ts LAND_CHECKS_PENDING_EXIT_CODE
      source: BSD sysexits.h (EX_TEMPFAIL 75)
      gaps: []
---
# Spec: `factory land` reports a structured result and a distinct exit code when checks are still pending (#4306)

## Goal

An orchestrator that runs `factory land <n>` should be able to tell "checks are still running" apart from every other "left open, not merged" outcome without parsing human text. Checks pending now exits 75 (`EX_TEMPFAIL`). A new `--json` flag ends stdout with one JSON result line whose `result` is `merged`, `checks_pending`, `checks_failed`, `conflicting` or `closed`. The contract is documented in `docs/cli-json-schemas.md` with a generated schema and a golden fixture. Human lines, other exit codes, the CI watch, its timing, `ci.skip` and the CI gate are unchanged.

## Files / approach

### 1. `packages/cli/src/cli/land-result-contract.ts` (new)

Pattern: `job-status-contract.ts`. Export:

```ts
const landResultBase = {
  schemaVersion: z.literal(1),
  pr: z.number().int(),
  headSha: z.string().nullable(),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
};
export const landResultJsonSchema = z.discriminatedUnion('result', [
  z.object({ ...landResultBase, result: z.literal('checks_pending'), pending: z.array(z.string()) }),
  z.object({ ...landResultBase, result: z.literal('checks_failed'), failed: z.array(z.string()) }),
  z.object({ ...landResultBase, result: z.enum(['merged', 'conflicting', 'closed']) }),
]);
export type LandResultJson = z.infer<typeof landResultJsonSchema>;
```

When serializing, put keys in the order the issue shows: `{"schemaVersion":1,"result":…,"pr":n,"headSha":…,"pending"|"failed":[…],"mergeable":…}`. `schemaVersion: 1` follows the repo's versioned-envelope convention and only adds a key to the issue's shape. `headSha` is null only when the PR read failed.

### 2. `packages/cli/src/cli/land-result.ts` (new)

- `export type LandResultKind = 'merged' | 'checks_pending' | 'checks_failed' | 'conflicting' | 'closed';`
- `export const LAND_CHECKS_PENDING_EXIT_CODE = 75;`
- `export class LandNoOpenPrError extends LandFailureError { constructor(message: string, readonly branches: readonly string[]) { super(message, 1); } }`. Import `LandFailureError` from `./land-pr.js`. No import cycle: land.ts imports this file, and this file never imports land.ts.
- `landResultKind(err)`:
  - `undefined` → `merged`
  - `isCiNotGreen(err)` → `checks_pending`. Check this before CiFailedError, because CiUnverifiedError is a subclass of it.
  - `err instanceof CiFailedError` → `checks_failed`
  - `LandConflictError` → `conflicting`
  - anything else → `undefined`. `closed` is decided only in printLandResult.
- `readLandResult(octokit, ghRepo, result, prNumber)`:
  - Split `ghRepo` into owner and repo.
  - In a try: `pulls.get` gives `headSha = data.head?.sha ?? null` and maps `data.mergeable` (true → MERGEABLE, false → CONFLICTING, otherwise UNKNOWN). On error: headSha null, UNKNOWN.
  - For `checks_pending` or `checks_failed` with a headSha, in a try:
    - `listAllCheckRuns(octokit, owner, repo, headSha, 100, 10)` from `@on-par/factory-core/internal`. Pending: `status !== 'completed'`. Failed: completed and conclusion not in `{success, neutral, skipped}`.
    - Also `octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: headSha, per_page: 100 })`. `pending` state → pending; `failure` or `error` → failed.
    - Use the name (or `context` for statuses), drop empty names, dedupe and sort.
    - On error the list stays `[]`. If both reads fail the other is still used; wrap each in its own try.
  - Return `pending` only for checks_pending and `failed` only for checks_failed.
- `printLandResult({ json, octokit, ghRepo, prNumber, error, write = (l) => console.log(l) })`:
  - Return at once when `!json`.
  - `kind = landResultKind(error)`. If `error instanceof LandNoOpenPrError`, call `latestPrForBranch(octokit, owner, repo, branch)` (from `./land-merged.js`) for each `error.branches` until one returns a PR. If found: `kind = 'closed'` and `prNumber = found.number`. A merged-but-not-open PR also reports `closed`, with the exit code unchanged at 1. If the lookup throws, print nothing.
  - If `kind` or `prNumber` is undefined, return without printing.
  - Otherwise `write(JSON.stringify(await readLandResult(...)))`.
  - The whole function must never throw: wrap it in a try/catch that swallows errors, so it can never change cmdLand's exit code.

### 3. `packages/cli/src/cli/land.ts`

- Add `onPrResolved?: (pr: { prNumber: number; branch: string }) => void;` to `landIssue`'s opts. Call `opts.onPrResolved?.({ prNumber, branch })` right after `const prNumber = lookup.prNumber;`.
- Replace `throw new LandFailureError(\`no open PR for issue #${issueNum} (${guessedBranch})\`, 1);` with `throw new LandNoOpenPrError(<same message>, guesses);`. Import it from `./land-result.js`.
- The file is at 491/500 lines, so add at most about 4 lines and no comments.

### 4. `packages/cli/src/cli/index.ts`

The file is at 4426 against its 4456 ceiling. Keep the change to about 15 lines or fewer.

- `cmdLand` opts gains `json?: boolean`. Declare `let prNumber: number | undefined;` and pass `onPrResolved: (p) => { prNumber = p.prNumber; }` to landIssue. Define `const report = (error?: unknown) => printLandResult({ json: opts.json === true, octokit, ghRepo, prNumber, error });`.
- Success: after the green line, `await report();`.
- `isCiNotGreen` branch: keep the yellow line, then `await report(err); throw new CliExitError('', LAND_CHECKS_PENDING_EXIT_CODE);` instead of `return`.
- `CiFailedError` branch: keep the yellow line, `await report(err);`, then `return` (exit 0 as today).
- `LandConflictError` and `LandFailureError` branches: call `await report(err);` before the existing throw. LandNoOpenPrError is a LandFailureError, so it keeps `err.code` 1 and the message.
- `AwaitingReviewError`, `MergeGatedError` and the generic exit-5 branch: no report.
- In `main()`'s handler (`if (err instanceof CliExitError) { console.error(...)`), print only when `err.message` is non-empty. Always set `process.exitCode = err.code`.
- Import `printLandResult` and `LAND_CHECKS_PENDING_EXIT_CODE` from `./land-result.js`.

### 5. `packages/cli/src/cli/program-run-work.ts`

On `land <issue>`, add `.option('--json', 'Print the land result (merged, checks_pending, checks_failed, conflicting, closed) as one JSON line on the last stdout line; checks still pending exit 75')`. opts already flows into cmdLand. If a help or README snapshot test (for example `cli-commands.test.ts`, `readme.test.ts`) asserts the option list, update the snapshot or docs it compares against.

### 6. Schema, fixture and contract tests

- In `scripts/gen-cli-json-schemas.ts`, import `landResultJsonSchema` from `../packages/cli/src/cli/land-result-contract.js` and add `['land-result.schema.json', landResultJsonSchema]`. Then run `npx tsx scripts/gen-cli-json-schemas.ts packages/cli/schemas` to create `packages/cli/schemas/land-result.schema.json`.
- Add the golden fixture `packages/cli/src/cli/__fixtures__/json/land-result.json`, a checks_pending example: `{"schemaVersion":1,"result":"checks_pending","pr":77,"headSha":"abc123","pending":["build","test"],"mergeable":"MERGEABLE"}`.
- `json-contract.test.ts` (494 lines): add the import and a `['land-result.schema.json', 'land-result.json', landResultJsonSchema]` row to `generatedContracts`. That is 2 lines.

### 7. Docs and changelog

- `docs/cli-json-schemas.md`:
  - Add the table row `factory land --json` (final stdout line) → `land-result.schema.json` / `land-result.json`. Version cell: "`schemaVersion` is `1`; `result` is `merged`, `checks_pending` (exit 75, with `pending`), `checks_failed` (with `failed`), `conflicting` or `closed`".
  - Bump the counts: seventeen contracts, sixteen versioned.
  - Remove `land` from the "Future JSON support" sentence; `#2279` keeps `resume-approved`.
  - Add a short "Land result" paragraph covering:
    - the exit codes per result: merged 0, checks_pending 75, checks_failed 0, conflicting 3, closed 1;
    - the key order;
    - that `pending`/`failed` list PR-head check run and status names, which may be empty when the wait was on base CI or the read failed;
    - that `mergeable` is UNKNOWN when GitHub has not computed it;
    - that outcomes outside the five (awaiting review exit 0, merge-gated exit 4, lookup or merge failure exit 1 or 5, no PR at all) print no result line.
- `docs/runbooks/github-actions-run.md`: one sentence saying `factory land` now exits 75 when checks are still pending, so the `FACTORY_MERGE=1` step fails with "factory land N exited 75" instead of passing with the PR unmerged.
- `CHANGELOG.md` `## Unreleased` → `### Added`: "- land: `factory land --json` prints a final result line (`merged`, `checks_pending`, `checks_failed`, `conflicting`, `closed`), and checks still pending now exit 75 (`EX_TEMPFAIL`) instead of 0 (#4306)".

## Tests

- **`packages/cli/src/cli/land-result.test.ts` (new):** fake octokit objects with `vi.fn`. Tests:
  - "maps a successful land to merged"
  - "maps every CI-not-green error to checks_pending": CiUnverifiedError, LandDeferredError, AwaitingCiError, BaseCiPendingError
  - "maps CiFailedError and CiInfraError to checks_failed"
  - "maps LandConflictError to conflicting"
  - "returns undefined for outcomes outside the five results": AwaitingReviewError, MergeGatedError, a plain LandFailureError, a generic Error
  - "lists pending and failed check names from check runs and commit statuses"
  - "maps mergeable true, false and null to MERGEABLE, CONFLICTING and UNKNOWN"
  - "falls back to a null headSha, UNKNOWN and empty lists when the reads fail"
  - "reports closed for LandNoOpenPrError when a closed PR exists on a guessed branch": pulls.list with state all returns a closed PR, and the line validates against landResultJsonSchema
  - "prints nothing when json is false"
  - Also assert that printLandResult resolves (never rejects) when every read throws.
- **`packages/cli/src/cli/land-result-contract.test.ts` (new):** "accepts each of the five result shapes", "rejects checks_pending without pending", "validates the golden fixture".
- **`packages/cli/src/cli/land-json.test.ts` (new; land.test.ts is at 491/500):** copy the minimal harness from land.test.ts: `defaultOctokit`, the inert loaders and git ops, the `watchChecks` fake, the exec fake for rev-parse and gh repo view, console spies, and calling `cmdLand` directly. Tests:
  - "prints a merged result line and exits 0"
  - "prints a checks_pending result line with pending check names and exits 75 on a CI-watch timeout": watchChecks → 'timeout'; checks.listForRef returns one in_progress run; rejects with `{ code: 75, message: '' }`.
  - "prints a checks_failed result line with failed check names and keeps exit 0": watchChecks → 'failure'.
  - "prints a conflicting result line and keeps exit 3": reuse the conflict setup from land.test.ts "exits 3 on a land sync conflict".
  - "prints a closed result line and keeps exit 1 when the branch PR is closed": pulls.list for open returns [], for all returns a closed PR.
  - "prints no JSON line and unchanged human lines without --json"
  - Each JSON test asserts that the last `console.log` line parses and passes `landResultJsonSchema.parse`, with the expected `result` and `pr`.
- **`packages/cli/src/cli/land.test.ts`:** rename and modify the timeout test to "cmdLand(5) exits 75 and leaves the PR open when CI never reaches a green verdict (timeout)". It expects `rejects.toMatchObject({ code: 75 })` and keeps the existing assertions on the line, the absence of a merge, cleanup and the ci-failed event. This is an intended behaviour change, not a deleted test. Also add to the main-dispatch suite (if it fits within 500 lines) a check that `runMain('land','5')` with a timeout returns code 75 and `errored()` is empty. Otherwise put that check in land-json.test.ts.
- **Proving commands:**
  - `npx vitest run packages/cli/src/cli/land-result.test.ts packages/cli/src/cli/land-result-contract.test.ts packages/cli/src/cli/land-json.test.ts packages/cli/src/cli/land.test.ts packages/cli/src/cli/json-contract.test.ts`
  - `bash scripts/check-cli-json-schemas.sh`
  - CHECK then runs `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- **Verify gate:** BUILD runs the focused vitest command above plus the schema check and reports that the full gate is pending. CHECK runs `bash scripts/verify.sh --no-e2e`. If coverage rises, raise the thresholds in `vitest.config.ts`; never lower them.
- **max-lines:**
  - index.ts stays under its 4456 ceiling because the logic lives in land-result.ts.
  - land.ts stays at or below 500.
  - The new schema goes in its own file because json-contract.ts is near 500.
  - New cmdLand tests go in land-json.test.ts because land.test.ts is near 500.
- **No test skipped or deleted:** the one timeout test is updated for the intended exit-75 change. No inline lint disables.
- **No comments:** none added (ADR-0177); `comments-baseline.json` is untouched.
- **Tests:** every changed source file has a colocated test:
  - land-result.ts → land-result.test.ts
  - land-result-contract.ts → land-result-contract.test.ts
  - land.ts / index.ts → land-json.test.ts and land.test.ts
  - program-run-work.ts → covered through cmdLand; update any help snapshot test
  - scripts/gen-cli-json-schemas.ts → json-contract.test.ts and the check script

  Each new behaviour has a test that fails without the change. Tests run from the repo root. `packages/core/package.json` is untouched.
- **Shell script tests:** no `scripts/*.sh` behaviour changes, so factory-run.test.sh and auto-merge-sweep.test.sh stay as they are.
- **Architecture:**
  - Only cli changes; core's existing `/internal` export `listAllCheckRuns` is used, and `.js` relative imports.
  - No model ids.
  - Domain terms: land, park, lane.
  - No ADR, per the plan instructions. The contract is documented in docs/cli-json-schemas.md, as that doc requires.
- **Docs and release hygiene:** a CHANGELOG `## Unreleased` `### Added` entry ending in (#4306); docs/cli-json-schemas.md and docs/runbooks/github-actions-run.md updated. No package.json version edits. `docs/config.example.yaml` is untouched, since there is no config change.
- **Safety:** no secrets in the JSON line, which holds only the PR number, sha, check names and mergeable. No shell interpolation; only Octokit calls. The CI gate is not weakened: the read happens only after the outcome is decided, and the merge path is unchanged. `ci.skip` keeps its meaning. The exit-75 change makes automation stricter, not looser.
- **ADR-0170/0175:** the land sync, deferral and SHA-pinned merge logic is untouched. LandDeferredError still parks or retries as before in lanes; only `factory land`'s CLI exit becomes 75.
- **ADR-0160:** not applicable; there is no config validation.

## Non-goals

- `--no-wait`, `land.waitForCi`, and any single-read or non-blocking land path (next slice).
- Wiring those flags through `factory land <issue>` (later slice).
- `resume-approved --json` (#2279).
- Changing the meaning of `ci.skip`, changing default timing or the CI watch, or weakening the CI gate.
- New result values for awaiting review, merge-gated or lookup failures, which print no result line.
- Changes to scripts/factory-run.sh or scripts/auto-merge-sweep.sh exit handling.
