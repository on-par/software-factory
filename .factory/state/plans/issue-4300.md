---
route: claude
design:
  restatedProblem: >-
    `classifyVisualProof` in packages/core/src/checkers/visual-proof.ts treats every changed file that
    matches a `visualProof.uiPaths` glob as a UI file. Broad globs such as `src/ui/**/*.tsx` also match
    colocated test files (`item-row.spec.tsx`, `foo.test.ts`, `__tests__/x.tsx`). Those files then take
    part in route selection and, when no route's `paths` match them, end up in `uncovered`. In
    `required` mode `runVisualProofCapture` then fails SHIP with "UI files not covered by any visualProof
    route", even though a test file renders no UI. Test files should be excluded from UI classification by
    default, and repos should be able to add their own exclusions through an optional
    `visualProof.excludePaths`.
  approach:
    chosen: >-
      Add an exported constant `DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS` to visual-proof.ts. It lists the
      default test-file globs written out without braces, because the local `globToRegExp` has no brace
      expansion: `**/*.spec.<ext>` and `**/*.test.<ext>` for each ext in ts, tsx, js, jsx, mts, cts, plus
      `**/__tests__/**`. Add an optional `excludePaths: string[]` to `VisualProofConfigSchema` that adds to
      the defaults rather than replacing them. In `classifyVisualProof`, compute
      `excluded = [...DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS, ...(config.excludePaths ?? [])]` and change the
      uiFiles filter to `matchesAny(config.uiPaths, f) && !matchesAny(excluded, f)`. Route selection and the
      `uncovered` list both derive from uiFiles, so both skip excluded files. Plan screenshot routes are
      unaffected.
    rejected:
      - option: Add brace expansion to globToRegExp and use the literal `**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts}` glob
        reason: >-
          This widens the matcher that also handles uiPaths and route paths, which is out-of-scope
          route-matching change. Writing the defaults out explicitly gives the same result with no change
          to the matcher.
      - option: Make excludePaths replace the defaults
        reason: >-
          The issue asks for a way to extend the defaults. Replacing them would let a repo re-enable the
          bug by accident, and there is no use case for treating a test file as UI.
      - option: Exclude test files only from the uncovered list
        reason: >-
          The acceptance criteria say route selection must come from the component alone, and a test-only
          change must not require proof at all.
  interfacesTouched:
    - packages/core/src/checkers/visual-proof.ts — new exported const DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS; classifyVisualProof filters excluded files out of uiFiles
    - packages/core/src/config/visual-proof-section.ts — VisualProofConfigSchema gains optional excludePaths
    - README.md — UI visual proof gate section documents the default exclusion and excludePaths
    - CHANGELOG.md — Unreleased Fixed entry
  targetTypes:
    - name: VisualProofConfig
      file: packages/core/src/config/visual-proof-section.ts
      kind: changed
    - name: VisualProofRequirement
      file: packages/core/src/checkers/visual-proof.ts
      kind: read
  signatures:
    - symbol: classifyVisualProof
      file: packages/core/src/checkers/visual-proof.ts
      signature: 'export function classifyVisualProof(input: { changedFiles: readonly string[]; config: VisualProofConfig | undefined; planRoutes: readonly string[]; }): VisualProofRequirement'
    - symbol: DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS
      file: packages/core/src/checkers/visual-proof.ts
      signature: 'export const DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS: readonly string[]'
  callGraph:
    - from: classifyVisualProof
      to: matchesAny
      note: changed files are checked against uiPaths, then against DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS plus config.excludePaths; excluded files never reach route selection or uncovered
    - from: runVisualProofCapture
      to: classifyVisualProof
      note: indirect, through the requirement; the uncovered list it fails on no longer contains test files
  behaviorContract:
    - A changed file matching uiPaths and a default test glob (*.spec.*, *.test.* for ts/tsx/js/jsx/mts/cts, or anything under __tests__/) is not a UI file
    - A change whose only uiPaths matches are test files returns { required false } when the plan names no screenshot route
    - Component plus spec selects routes from the component only and has no uncovered entry for the spec
    - A non-test UI file that no route covers is still in uncovered
    - visualProof.excludePaths adds globs to the default exclusions; it does not replace them
    - Plan screenshot routes still force required true, even when every changed UI file is excluded
  verificationPlan:
    - command: npx vitest run packages/core/src/checkers/visual-proof.test.ts packages/core/src/config/visual-proof-section.test.ts
      passWhen: all tests pass, including the new #4300 cases
    - command: bash scripts/verify.sh --no-e2e
      passWhen: exits 0 (the CHECK full gate)
  riskBlastRadius: >-
    Only visual-proof classification in SHIP changes. If the exclusion is too broad, a real UI file named
    like `*.test.tsx`, or one under `__tests__/`, would skip visual proof; that naming is a test convention
    and is accepted. If excludePaths is wired wrong, the config schema could reject existing configs. The
    key is optional and the schema is strict, so existing configs still parse.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: A run whose only uiPaths changes are test files does not require visual proof — classifyVisualProof returns { required false } for changed files that are only spec/test/__tests__ files under uiPaths
      test: packages/core/src/checkers/visual-proof.test.ts "does not require proof when the only UI-path changes are test files (#4300)"
    - kind: fail-to-pass-test
      claim: Component plus spec selects routes from the component and reports nothing uncovered — with uiPaths src/ui/**/*.tsx and a route paths src/ui/items/**/item-*.tsx, changing item-row.tsx and item-row.spec.tsx selects /items and has no uncovered
      test: packages/core/src/checkers/visual-proof.test.ts "selects routes from the component alone and never reports its spec as uncovered (#4300)"
    - kind: fail-to-pass-test
      claim: An uncovered non-test UI file is still reported — a changed non-test UI file outside every route stays in uncovered, while a test file next to it does not appear
      test: packages/core/src/checkers/visual-proof.test.ts "still reports an uncovered non-test UI file next to excluded test files (#4300)"
    - kind: fail-to-pass-test
      claim: Users can extend the default exclusions with visualProof.excludePaths — the schema accepts excludePaths, and a file matching it is neither selected nor uncovered while the default test exclusion still applies
      test: packages/core/src/checkers/visual-proof.test.ts "visualProof.excludePaths extends the default exclusions (#4300)"
    - kind: command
      claim: The default test-file exclusion is documented — the README visual proof section names the default exclusion and excludePaths
      command: grep -c "excludePaths" README.md
      passWhen: prints a count of at least 1
      expect:
        exitCode: 0
  outline:
    - result: classifyVisualProof ignores default test files when it selects routes and builds the uncovered list
      files:
        - packages/core/src/checkers/visual-proof.ts
        - packages/core/src/checkers/visual-proof.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/checkers/visual-proof.test.ts
      manualChecks: []
    - result: visualProof.excludePaths parses and extends the exclusions
      files:
        - packages/core/src/config/visual-proof-section.ts
        - packages/core/src/config/visual-proof-section.test.ts
        - packages/core/src/checkers/visual-proof.test.ts
      automatedChecks:
        - npx vitest run packages/core/src/config/visual-proof-section.test.ts packages/core/src/checkers/visual-proof.test.ts
      manualChecks: []
    - result: Docs and changelog describe the default exclusion and excludePaths
      files:
        - README.md
        - CHANGELOG.md
      automatedChecks:
        - npm run config-example && git diff --exit-code docs/config.example.yaml
      manualChecks:
        - Read the README UI visual proof gate section and confirm the default globs and excludePaths are listed
---
# Spec: Visual proof treats changed test files as UI files, so a run that edits a component spec fails SHIP with "UI files not covered by any visualProof route" (#4300)

## Goal
SHIP's visual proof gate counts colocated test files (`*.spec.tsx`, `*.test.ts`, `__tests__/**`) as UI whenever a broad `visualProof.uiPaths` glob matches them. So a run that adds a spec next to a component fails SHIP with "UI files not covered by any visualProof route", and a test-only change demands visual proof. Test files render no UI. Exclude them from UI classification by default, and let repos add their own exclusions through an optional `visualProof.excludePaths`.

## Files / approach

1. `packages/core/src/checkers/visual-proof.ts`
   - Add the export below, after `matchesAny`. The local `globToRegExp` has **no brace expansion**, so write each glob out:
     ```ts
     const TEST_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts'] as const;
     export const DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS: readonly string[] = [
       ...TEST_EXTENSIONS.flatMap((ext) => [`**/*.spec.${ext}`, `**/*.test.${ext}`]),
       '**/__tests__/**',
     ];
     ```
     With the existing `globToRegExp`, `**/*.spec.tsx` matches `item-row.spec.tsx` and `src/ui/items/item-row.spec.tsx`, and `**/__tests__/**` matches `src/ui/__tests__/a.tsx`. Confirm both in a test.
   - In `classifyVisualProof`, after the `!config` branch:
     ```ts
     const excluded = [...DEFAULT_VISUAL_PROOF_EXCLUDE_PATHS, ...(config.excludePaths ?? [])];
     const uiFiles = changedFiles.filter((f) => matchesAny(config.uiPaths, f) && !matchesAny(excluded, f));
     ```
     Leave the rest alone: route selection, `uncovered`, planRoutes handling and the maxCaptures slice. They all derive from `uiFiles`.
   - knip may flag the new export if only the test imports it. If it does, use it in the test and keep it exported, or make it non-exported and test it through behaviour only. Either is fine. Do not add a knip ignore.

2. `packages/core/src/config/visual-proof-section.ts`
   - In `VisualProofConfigSchema`, after `uiPaths`, add:
     `excludePaths: z.array(z.string().min(1)).optional().describe('Extra globs excluded from uiPaths, added to the default test-file exclusions (**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts}, **/__tests__/**)'),`
   - The key is optional, so configs that parse today still parse. No ADR-0160 staging is needed because nothing gets stricter.

3. `README.md`, in the "UI visual proof gate" section:
   - In the yaml example, add a line after `uiPaths`: `excludePaths: ['src/ui/**/*.stories.tsx'] # optional; added to the default test-file exclusions`.
   - Add one sentence after the yaml block or the intro paragraph: changed files matching `**/*.{spec,test}.{ts,tsx,js,jsx,mts,cts}` or `**/__tests__/**` never count as UI, even when `uiPaths` matches them; they select no route and are never reported as uncovered; `visualProof.excludePaths` adds more globs.

4. `CHANGELOG.md`: under `## Unreleased`, add a `### Fixed` subsection with one line, for example: "Visual proof no longer counts changed test files (`*.spec.*`, `*.test.*`, `__tests__/`) as UI, so a component spec no longer fails SHIP as uncovered; `visualProof.excludePaths` adds more exclusions (#4300)."

5. Run `npm run config-example`. The visualProof entry in `docs/config.example.yaml` is a fixed hint string, so this should produce no diff. If it does produce one, commit the regenerated file. Never hand-edit it.

## Tests
Add to `packages/core/src/checkers/visual-proof.test.ts`, inside `describe('classifyVisualProof')` or a new `describe('classifyVisualProof test-file exclusion (#4300)')`. Use a local config built with `VisualProofConfigSchema.parse({ uiPaths: ['src/ui/**/*.tsx'], routes: [{ route: '/items', assert: 'Items', paths: ['src/ui/items/**/item-*.tsx'] }], command: ['node', 'capture.mjs'] })`:
- "does not require proof when the only UI-path changes are test files (#4300)": changedFiles `['src/ui/items/item-row.spec.tsx', 'src/ui/other/x.test.tsx', 'src/ui/__tests__/y.tsx']` and planRoutes `[]` → `toEqual({ required: false })`.
- "selects routes from the component alone and never reports its spec as uncovered (#4300)": changedFiles `['src/ui/items/item-row.tsx', 'src/ui/items/item-row.spec.tsx']` → required, routes `['/items']`, and no `uncovered` property.
- "still reports an uncovered non-test UI file next to excluded test files (#4300)": changedFiles `['src/ui/other/panel.tsx', 'src/ui/other/panel.test.tsx']` → `uncovered` equals `['src/ui/other/panel.tsx']`.
- "visualProof.excludePaths extends the default exclusions (#4300)": the same config plus `excludePaths: ['src/ui/**/*.stories.tsx']`. Changed files `['src/ui/other/a.stories.tsx', 'src/ui/other/a.spec.tsx']` → `{ required: false }`. Without excludePaths, the same files → `uncovered` `['src/ui/other/a.stories.tsx']`.
- Optionally assert that a plan route still forces `required: true` when every changed file is excluded.

Add to `packages/core/src/config/visual-proof-section.test.ts`: excludePaths is optional (absent from the base parse), accepts a string array, and rejects `['']` and a non-array.

Commands:
- Focused: `npx vitest run packages/core/src/checkers/visual-proof.test.ts packages/core/src/config/visual-proof-section.test.ts`
- Full gate (CHECK): `bash scripts/verify.sh --no-e2e`

## Constitution compliance
- Verify gate: BUILD runs the focused vitest command under the `.factory` focused handoff and reports that the full gate is pending. CHECK runs `bash scripts/verify.sh --no-e2e`. No thresholds are lowered. If the coverage ratchet reports a rise, raise the threshold.
- Tests: the colocated `visual-proof.test.ts` and `visual-proof-section.test.ts` are updated. The new cases fail before the change: today the spec lands in uncovered and test-only changes are required.
- No comments are added. Imports use `.js`. Strict TS.
- Architecture: all changes stay inside `core`. No model ids, no package-boundary changes, no ADR (none requested).
- Docs and release: README section and a CHANGELOG `### Fixed` entry ending in (#4300). `docs/config.example.yaml` is only regenerated. No version edits.
- Safety: no shell, secrets or workflow changes. The guardrail is narrowed only for files that cannot render UI, so required proof still applies to every non-test UI file.
- Domain terms: SHIP, CHECK and lane are used as defined.

## Non-goals
- Changing the route-matching algorithm or `globToRegExp` (no brace expansion support).
- Non-UI file handling, CHECK behaviour, and capture, manifest or attach logic.
- Letting excludePaths remove the default exclusions.
