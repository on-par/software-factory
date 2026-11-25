---
route: claude
design:
  restatedProblem: >-
    The one-line engine summary in the README introduction ("Built in TypeScript. Routes work across
    Claude and Codex, with experimental local models through Ollama, and logs cost per task.") names
    Claude, Codex and Ollama but not OpenCode or GitHub Copilot CLI, both of which the factory
    supports as experimental harnesses (docs/agents.md Harness matrix). A new user reading the intro
    therefore does not learn those engines are available. The same intro line is mirrored verbatim in
    packages/cli/README.md (the npm-published README), so both copies should say the same thing.
  approach:
    chosen: >-
      Rewrite only the "Built in TypeScript." intro sentence in README.md and its verbatim mirror in
      packages/cli/README.md so it names Claude Code, Codex, OpenCode, GitHub Copilot CLI and
      Ollama, keeping the experimental qualifier and the cost-per-task clause. Add a guard test in
      packages/cli/src/readme.test.ts that extracts the intro line from both READMEs and checks every
      engine name is present, plus a self-test that rejects the old sentence. Add a CHANGELOG
      Unreleased entry.
    rejected:
      - option: Edit only the root README.md
        reason: >-
          packages/cli/README.md carries the identical intro and is what npm users see; leaving it
          stale would split the two copies of the same intro.
      - option: Add a bulleted engine list or table to the intro
        reason: >-
          The intro is a two-sentence summary; the full matrix already lives in docs/agents.md and
          docs/status.md. A one-sentence edit is the smallest change that meets the criteria.
      - option: Also add Pi to the intro
        reason: The issue names only OpenCode and GitHub Copilot; adding Pi widens scope.
  interfacesTouched:
    - README.md (intro sentence, line 5)
    - packages/cli/README.md (intro sentence, line 7)
    - packages/cli/src/readme.test.ts (new intro-engines guard + self-test)
    - CHANGELOG.md (## Unreleased, ### Changed entry)
  targetTypes: []
  signatures: []
  callGraph: []
  behaviorContract:
    - The README.md intro sentence names Claude Code, Codex, OpenCode, GitHub Copilot and Ollama.
    - The packages/cli/README.md intro sentence is identical to the README.md one.
    - The experimental qualifier still covers OpenCode, GitHub Copilot CLI and Ollama, and the "logs cost per task" clause is kept.
    - A test fails if any of the five engine names disappears from either intro sentence.
  verificationPlan:
    - command: npx vitest run packages/cli/src/readme.test.ts
      passWhen: All tests pass, including the new "README intro engines" tests.
    - command: bash scripts/verify.sh --no-e2e
      passWhen: Exits 0 (run by CHECK before SHIP).
  riskBlastRadius: >-
    Docs only plus one test. Worst case is wording a reader finds awkward, or a prettier format-check
    failure if the markdown is reformatted. No runtime code changes.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        A new user reading the README introduction sees OpenCode and GitHub Copilot listed alongside
        the other engines — the test pulls the intro sentence from README.md and packages/cli/README.md
        and asserts it contains "OpenCode" and "GitHub Copilot".
      test: packages/cli/src/readme.test.ts "README.md and packages/cli/README.md intro names every engine"
    - kind: fail-to-pass-test
      claim: >-
        The engines already listed in the intro stay listed — the same test asserts the intro sentence
        still contains "Claude", "Codex" and "Ollama", and the self-test shows the old sentence is
        reported as missing only OpenCode and GitHub Copilot.
      test: packages/cli/src/readme.test.ts "README.md and packages/cli/README.md intro names every engine" "rejects the pre-fix intro that omits OpenCode and GitHub Copilot"
  outline:
    - result: Both README intros name Claude Code, Codex, OpenCode, GitHub Copilot CLI and Ollama, and a guard test enforces it.
      files:
        - README.md
        - packages/cli/README.md
        - packages/cli/src/readme.test.ts
        - CHANGELOG.md
      automatedChecks:
        - npx vitest run packages/cli/src/readme.test.ts
        - npx prettier --check README.md packages/cli/README.md CHANGELOG.md packages/cli/src/readme.test.ts
      manualChecks:
        - Read the rendered README intro on the PR and confirm OpenCode and GitHub Copilot appear next to Claude Code, Codex and Ollama.
---
# Spec: README intro: list OpenCode and Copilot alongside the other engines (#4354)

## Goal

New users scanning the README intro should see every engine the factory can route work to. Today
the intro sentence names Claude, Codex and Ollama only, though OpenCode and GitHub Copilot CLI are
supported as experimental harnesses (see `docs/agents.md` → Harness matrix). Update that sentence,
keep its mirror in the CLI package README the same, and add a guard test so the names cannot be
dropped again unnoticed.

## Files / approach

1. `README.md` line 5. Replace

   `Built in TypeScript. Routes work across Claude and Codex, with experimental local models through Ollama, and logs cost per task.`

   with

   `Built in TypeScript. Routes work across Claude Code and Codex, with experimental support for OpenCode, GitHub Copilot CLI and local models through Ollama, and logs cost per task.`

2. `packages/cli/README.md` line 7: the same replacement, word for word.

3. `packages/cli/src/readme.test.ts`: append a new block after the existing `README wording` /
   `README wording guard self-test` blocks (or at the end of the file), using only existing
   imports and the existing `rootReadme` / `cliReadme` constants:

   ```ts
   const INTRO_ENGINES = ['Claude', 'Codex', 'OpenCode', 'GitHub Copilot', 'Ollama'];
   const OLD_INTRO =
     'Built in TypeScript. Routes work across Claude and Codex, with experimental local models through Ollama, and logs cost per task.';

   function introEngineProblems(text: string): string[] {
     const intro = text.split('\n').find((l) => l.startsWith('Built in TypeScript.'));
     if (intro === undefined) return ['missing intro line'];
     return INTRO_ENGINES.filter((e) => !intro.includes(e)).map((e) => `intro missing: ${e}`);
   }

   describe('README intro engines', () => {
     it('README.md and packages/cli/README.md intro names every engine', () => {
       expect(introEngineProblems(rootReadme)).toEqual([]);
       expect(introEngineProblems(cliReadme)).toEqual([]);
     });
   });

   describe('README intro engines guard self-test', () => {
     it('rejects the pre-fix intro that omits OpenCode and GitHub Copilot', () => {
       expect(introEngineProblems(OLD_INTRO)).toEqual(['intro missing: OpenCode', 'intro missing: GitHub Copilot']);
     });

     it('reports a missing intro line on an empty README', () => {
       expect(introEngineProblems('')).toEqual(['missing intro line']);
     });
   });
   ```

   No comments (ADR-0177). Keep the names `introEngineProblems`, `INTRO_ENGINES`, `OLD_INTRO`
   unless they collide with an existing identifier in the file (they do not today).

4. `CHANGELOG.md`: under `## Unreleased`, add a `### Changed` subsection (after the existing
   `### Added`) with one line:

   `- The README intro now names OpenCode and GitHub Copilot CLI alongside Claude Code, Codex and Ollama (#4354)`

## Tests

- New tests in `packages/cli/src/readme.test.ts` (above). "intro names every engine" fails before the
  README edit (OpenCode and GitHub Copilot missing) and passes after; the self-tests pin the
  detector's behavior.
- Focused: `npx vitest run packages/cli/src/readme.test.ts`.
- Full gate (CHECK): `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- Verify gate: focused vitest in BUILD per the handoff; CHECK runs `bash scripts/verify.sh --no-e2e`.
  Run prettier on changed markdown and the test file.
- Coverage thresholds: untouched; test-only and docs change, no thresholds lowered.
- No tests skipped/deleted; no lint disables.
- No new comments: the added test code carries none.
- Tests colocated: the README guard lives in the existing `packages/cli/src/readme.test.ts`;
  the new behavior has a fail-to-pass test.
- Architecture / package boundaries / model routing: untouched (no source code changes).
- ADRs: none needed; no design decision.
- Docs and release hygiene: user-visible README change gets a `## Unreleased` → `### Changed` line
  ending in `(#4354)`. No `package.json` version edits. `docs/config.example.yaml` untouched.
- Safety: no secrets, paths or shell changes.

## Non-goals

- Any change to engine support, configuration or behavior for OpenCode, Copilot or other engines.
- Edits to other README sections (Safety, Quick start, Status), `docs/agents.md`, `docs/status.md`
  or other engine references.
- Adding engines not named in the issue (for example Pi) to the intro.
