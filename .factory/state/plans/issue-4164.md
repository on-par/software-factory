---
route: claude
design:
  restatedProblem: >-
    `packages/core/src/worktree/worktree-gc.ts` re-exports `findCredentialFiles`, `scrubFile`, `zeroFill`
    (from `./worktree-gc-scrub.js`) and `isZeroCommitLane` (from `./worktree-gc-evidence.js`). No production
    code consumes these re-exports; only two tests reach them through the `packages/core/src/utils/worktree-gc.ts`
    shim (`export * from '../worktree/worktree-gc.js'`). `knip --production` reports the four re-exports and they
    sit in the `production` list of `knip-baseline.json`. The fix drops the re-exports, points the tests at the
    defining modules, and removes the four baseline keys.
  approach:
    chosen: >-
      Delete line 36 (`export { findCredentialFiles, scrubFile, zeroFill } from './worktree-gc-scrub.js';`) and remove
      `isZeroCommitLane` from line 37 of worktree-gc.ts. Keep the private import on line 19 (findCredentialFiles and
      scrubFile are still used by sweepWorktrees). Leave the functions and their `export` keywords in
      worktree-gc-scrub.ts and worktree-gc-evidence.ts: knip.jsonc sets `ignoreExportsUsedInFile: true`, and zeroFill and
      isZeroCommitLane are used inside their own files, so knip raises no new finding there. Change the two tests to import
      the symbols from their defining modules. Delete the four baseline keys.
    rejected:
      - option: Delete the functions and their tests
        reason: All four are live. sweepWorktrees calls findCredentialFiles and scrubFile, scrubFile calls zeroFill, and gatherWorktreeEvidence calls isZeroCommitLane. Only the re-export is dead.
      - option: Also remove the `export` keyword in worktree-gc-scrub.ts / worktree-gc-evidence.ts
        reason: The tests need those exports, worktree-gc.ts imports findCredentialFiles and scrubFile, and that file is out of scope.
  interfacesTouched:
    - packages/core/src/worktree/worktree-gc.ts (drop re-exports of findCredentialFiles, scrubFile, zeroFill, isZeroCommitLane)
    - packages/core/src/utils/worktree-gc.test.ts (import from ../worktree/worktree-gc-scrub.js)
    - packages/core/src/utils/worktree-gc-2964.test.ts (import isZeroCommitLane from ../worktree/worktree-gc-evidence.js)
    - knip-baseline.json (remove 4 production keys)
  targetTypes: []
  signatures:
    - symbol: findCredentialFiles
      file: packages/core/src/worktree/worktree-gc-scrub.ts
      signature: 'export function findCredentialFiles(worktreePath: string): string[]'
    - symbol: zeroFill
      file: packages/core/src/worktree/worktree-gc-scrub.ts
      signature: 'export function zeroFill(filePath: string): void'
    - symbol: scrubFile
      file: packages/core/src/worktree/worktree-gc-scrub.ts
      signature: 'export function scrubFile(filePath: string): void'
  callGraph:
    - from: sweepWorktrees
      to: findCredentialFiles
      note: worktree path in, credential file paths out (private import on worktree-gc.ts line 19, unchanged)
    - from: sweepWorktrees
      to: scrubFile
      note: each credential file path (unchanged)
    - from: scrubFile
      to: zeroFill
      note: file path, local call in worktree-gc-scrub.ts (unchanged)
    - from: gatherWorktreeEvidence
      to: isZeroCommitLane
      note: runCommand, repoRoot and head, local call in worktree-gc-evidence.ts (unchanged)
  behaviorContract:
    - worktree-gc.ts (and so the utils/worktree-gc.ts shim) no longer exports findCredentialFiles, scrubFile, zeroFill or isZeroCommitLane.
    - knip-baseline.json no longer lists the four worktree-gc.ts keys, and `npm run knip` passes with no new findings.
    - Runtime behavior of sweepWorktrees is unchanged.
  verificationPlan:
    - command: npm run knip
      passWhen: exit 0 with no added or removed baseline keys reported
    - command: npx vitest run packages/core/src/utils/worktree-gc.test.ts packages/core/src/utils/worktree-gc-2964.test.ts packages/core/src/worktree
      passWhen: all tests pass
    - command: bash scripts/verify.sh --no-e2e
      passWhen: green
  riskBlastRadius: >-
    Low. A missed consumer of the re-exports would fail typecheck. grep finds none outside the two tests, and
    internal.ts re-exports only countUnpushedCommits, formatGcReport, isWorktreeClean, parseWorktreeList and sweepWorktrees.
    If knip did flag the source-module exports, `npm run knip` would fail with an added key and the BUILD phase would see it.
  openQuestions: []
  evidencePlan:
    - kind: command
      claim: findCredentialFiles in packages/core/src/worktree/worktree-gc.ts is deleted, or de-exported if still used locally.
      command: bash -c "! grep -nE '^export .*findCredentialFiles' packages/core/src/worktree/worktree-gc.ts && echo OK"
      passWhen: no export of findCredentialFiles remains in worktree-gc.ts
      expect:
        exitCode: 0
        stdoutContains: [OK]
    - kind: command
      claim: isZeroCommitLane in packages/core/src/worktree/worktree-gc.ts is deleted, or de-exported if still used locally.
      command: bash -c "! grep -n 'isZeroCommitLane' packages/core/src/worktree/worktree-gc.ts && echo OK"
      passWhen: isZeroCommitLane no longer appears in worktree-gc.ts
      expect:
        exitCode: 0
        stdoutContains: [OK]
    - kind: command
      claim: scrubFile in packages/core/src/worktree/worktree-gc.ts is deleted, or de-exported if still used locally.
      command: bash -c "! grep -nE '^export .*scrubFile' packages/core/src/worktree/worktree-gc.ts && echo OK"
      passWhen: no export of scrubFile remains in worktree-gc.ts
      expect:
        exitCode: 0
        stdoutContains: [OK]
    - kind: command
      claim: zeroFill in packages/core/src/worktree/worktree-gc.ts is deleted, or de-exported if still used locally.
      command: bash -c "! grep -n 'zeroFill' packages/core/src/worktree/worktree-gc.ts && echo OK"
      passWhen: zeroFill no longer appears in worktree-gc.ts
      expect:
        exitCode: 0
        stdoutContains: [OK]
    - kind: command
      claim: Any tests that referenced these symbols solely via the export are updated (to import from their own module) or removed accordingly.
      command: npx vitest run packages/core/src/utils/worktree-gc.test.ts packages/core/src/utils/worktree-gc-2964.test.ts
      passWhen: both files type-resolve their imports from worktree-gc-scrub.js / worktree-gc-evidence.js and all tests pass
    - kind: command
      claim: The 4 corresponding keys are removed from knip-baseline.json.
      command: bash -c "! grep -n 'worktree/worktree-gc.ts|' knip-baseline.json && echo OK"
      passWhen: no baseline key for packages/core/src/worktree/worktree-gc.ts remains
      expect:
        exitCode: 0
        stdoutContains: [OK]
    - kind: command
      claim: No new dead-code entries are introduced for worktree-gc.ts.
      command: npm run knip
      passWhen: exit 0; the baseline script reports no added keys (it fails on any added or removed key)
      expect:
        exitCode: 0
  outline:
    - result: worktree-gc.ts drops the four re-exports and the tests import from the defining modules; tests pass
      files:
        - packages/core/src/worktree/worktree-gc.ts
        - packages/core/src/utils/worktree-gc.test.ts
        - packages/core/src/utils/worktree-gc-2964.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/utils/worktree-gc.test.ts packages/core/src/utils/worktree-gc-2964.test.ts
        - npm run typecheck
      manualChecks: []
    - result: baseline shrunk by 4 keys and knip passes
      files:
        - knip-baseline.json
      automatedChecks:
        - npm run knip
        - bash scripts/verify.sh --no-e2e
      manualChecks: []
---
# Spec: knip: delete dead exports in packages/core/src/worktree (part of #4126) (#4164)

## Goal
Remove four dead re-exports from `packages/core/src/worktree/worktree-gc.ts`: `findCredentialFiles`, `scrubFile`, `zeroFill` and `isZeroCommitLane`. Then delete their `knip-baseline.json` keys, so `knip --production` stays clean and the baseline shrinks, as tracked in #4126. The functions are live code, so they stay. Only the re-export surface goes away.

## Files / approach
1. `packages/core/src/worktree/worktree-gc.ts`
   - Delete line 36: `export { findCredentialFiles, scrubFile, zeroFill } from './worktree-gc-scrub.js';`
   - Change line 37 to `export { countUnpushedCommits, isWorktreeClean } from './worktree-gc-evidence.js';`, which drops `isZeroCommitLane`.
   - Keep line 19, `import { findCredentialFiles, scrubFile } from './worktree-gc-scrub.js';`, because `sweepWorktrees` uses both.
2. `packages/core/src/utils/worktree-gc.test.ts`
   - Remove `findCredentialFiles`, `scrubFile` and `zeroFill` from the `./worktree-gc.js` import.
   - Add `import { findCredentialFiles, scrubFile, zeroFill } from '../worktree/worktree-gc-scrub.js';`.
   - Keep the import groups ordered the way the lint/format config expects. Run `npm run lint` / prettier.
3. `packages/core/src/utils/worktree-gc-2964.test.ts`
   - Change `import { isZeroCommitLane, sweepWorktrees } from './worktree-gc.js';` to `import { sweepWorktrees } from './worktree-gc.js';`.
   - Add `import { isZeroCommitLane } from '../worktree/worktree-gc-evidence.js';`.
4. `knip-baseline.json`: delete exactly these four lines from the `production` array:
   - `production|exports|packages/core/src/worktree/worktree-gc.ts|findCredentialFiles`
   - `...|isZeroCommitLane`
   - `...|scrubFile`
   - `...|zeroFill`

   Watch the trailing commas so the JSON stays valid. Do not touch the `production|files|packages/core/src/utils/worktree-gc.ts|...` entry.

Do not touch `worktree-gc-scrub.ts` or `worktree-gc-evidence.ts`. `knip.jsonc` sets `ignoreExportsUsedInFile: true`, and `zeroFill` (called by `scrubFile`) and `isZeroCommitLane` (called by `gatherWorktreeEvidence`) are used inside their own files. The worktree-gc.ts import keeps `findCredentialFiles` and `scrubFile` in use. So knip raises no new findings. `packages/core/src/internal.ts` does not re-export any of the four, so the public API is unaffected.

## Tests
No new tests. The behavior does not change, and the existing tests keep covering the functions through their defining modules. Proof:
- `npx vitest run packages/core/src/utils/worktree-gc.test.ts packages/core/src/utils/worktree-gc-2964.test.ts` (run from the repo root)
- `npm run knip` (the baseline script fails on any added or removed key)
- `bash scripts/verify.sh --no-e2e`

## Constitution compliance
- Builds and type-checks: only import paths change, and typecheck runs inside verify.sh.
- Tests pass, and new behavior comes with tests: there is no new behavior. The existing colocated tests are updated next to the source change.
- Lint is clean: import ordering is kept and no comments are added (ADR-0177).
- The diff does only what the issue asks: three source/test files plus four baseline lines.
- No secrets, debug leftovers or disabled tests: none are introduced, and no tests are deleted or skipped.
- No CHANGELOG entry: this is an internal change, not visible to users or ops. Coverage thresholds are untouched.

## Non-goals
- Other `knip-baseline.json` entries, including `production|files|packages/core/src/utils/worktree-gc.ts`.
- Dead-export cleanup in other files (tracked under #4126).
- Refactoring worktree-gc.ts, worktree-gc-scrub.ts or worktree-gc-evidence.ts.
