---
route: claude
design:
  restatedProblem: >-
    The Prerequisites section printed by `factory --help` comes from the exported
    `PREREQUISITES_TEXT` constant in packages/cli/src/cli/index.ts. Its engine list names
    "Claude Code, Codex, OpenCode or Pi" but leaves out GitHub Copilot CLI, which the factory
    supports as an experimental engine (the README intro, README line 99 and docs/agents.md all
    name it). So a Copilot CLI user reading `--help` sees nothing that says their setup counts.
    The fix adds GitHub Copilot CLI to that one line and keeps every existing engine. It also
    updates the colocated test and the committed `--help` baseline fixture that verify.sh diffs
    against.
  approach:
    chosen: >-
      Change the engine list in PREREQUISITES_TEXT to "Claude Code, Codex, OpenCode, GitHub
      Copilot CLI or Pi". Add a Copilot assertion, and assertions for the existing engines, to
      the cli.test.ts publish-contract test. Regenerate scripts/fixtures/factory-help.txt with
      `bash scripts/cli-help-baseline.sh --update` after `npm run build`. Add a CHANGELOG
      Unreleased "Changed" entry.
    rejected:
      - option: Derive the engine list from the harness registry in core
        reason: Over-engineered for a one-line help string. It would add a core dependency to static help text, and the issue scopes the change to the text only.
      - option: Hand-edit scripts/fixtures/factory-help.txt without regenerating
        reason: Error-prone. The baseline script's --update mode writes the exact bytes that verify.sh compares against.
  interfacesTouched:
    - packages/cli/src/cli/index.ts — exported const PREREQUISITES_TEXT (string content only)
    - packages/cli/src/cli.test.ts — publish contract test for PREREQUISITES_TEXT
    - scripts/fixtures/factory-help.txt — committed `factory --help` baseline
    - CHANGELOG.md — Unreleased Changed entry
  targetTypes: []
  signatures: []
  callGraph:
    - from: scripts/cli-help-baseline.sh
      to: PREREQUISITES_TEXT
      note: verify.sh runs the built CLI's --help, which prints PREREQUISITES_TEXT, and diffs the output against scripts/fixtures/factory-help.txt
  behaviorContract:
    - PREREQUISITES_TEXT, and so `factory --help`, names GitHub Copilot CLI in the supported coding agent line
    - Claude Code, Codex, OpenCode and Pi are all still named on that line
    - scripts/fixtures/factory-help.txt matches the new `factory --help` output
  verificationPlan:
    - command: npx vitest run packages/cli/src/cli.test.ts -t "PREREQUISITES_TEXT"
      passWhen: Both PREREQUISITES_TEXT publish-contract tests pass, including the new Copilot assertion
    - command: npm run build && bash scripts/cli-help-baseline.sh
      passWhen: Exits 0 with no diff once the fixture has been regenerated
    - command: bash scripts/verify.sh --no-e2e
      passWhen: Full gate green (run by CHECK)
  riskBlastRadius: >-
    Text-only change. If the fixture is not regenerated, verify.sh's cli-help-baseline step
    fails and blocks CI. No runtime behavior changes.
  openQuestions: []
  evidencePlan:
    - kind: fail-to-pass-test
      claim: >-
        factory --help lists GitHub Copilot CLI in Prerequisites — the test asserts that
        PREREQUISITES_TEXT contains "GitHub Copilot CLI"
      test: packages/cli/src/cli.test.ts "PREREQUISITES_TEXT names any supported coding agent, not only Claude Code"
    - kind: command
      claim: >-
        Prerequisites text is consistent with the README, which names GitHub Copilot CLI — the
        built CLI's --help output contains the same "GitHub Copilot CLI" name the README uses
      command: npm run build >/dev/null && node packages/cli/dist/cli.js --help
      passWhen: The Prerequisites line names GitHub Copilot CLI, matching the README intro's wording
      expect:
        exitCode: 0
        stdoutContains:
          - "Prerequisites:"
          - "GitHub Copilot CLI"
    - kind: command
      claim: >-
        No existing engine is dropped — the built --help output still names Claude Code, Codex,
        OpenCode and Pi, and the committed baseline matches it
      command: npm run build >/dev/null && node packages/cli/dist/cli.js --help && bash scripts/cli-help-baseline.sh
      passWhen: Output contains all five engine names and the baseline diff is empty (exit 0)
      expect:
        exitCode: 0
        stdoutContains:
          - "Claude Code, Codex, OpenCode, GitHub Copilot CLI or Pi"
  outline:
    - result: PREREQUISITES_TEXT names GitHub Copilot CLI and all four existing engines, and the unit test asserts all five
      files:
        - packages/cli/src/cli/index.ts
        - packages/cli/src/cli.test.ts
      automatedChecks:
        - npx vitest run packages/cli/src/cli.test.ts -t "PREREQUISITES_TEXT"
      manualChecks: []
    - result: The committed --help baseline and the changelog reflect the new line
      files:
        - scripts/fixtures/factory-help.txt
        - CHANGELOG.md
      automatedChecks:
        - npm run build && bash scripts/cli-help-baseline.sh
      manualChecks:
        - Run `node packages/cli/dist/cli.js --help` and check the Prerequisites section by eye
---
# Spec: factory --help: name GitHub Copilot CLI in prerequisites (#4355)

## Goal

`factory --help` should name GitHub Copilot CLI as a supported coding agent CLI in its
Prerequisites section, next to Claude Code, Codex, OpenCode and Pi. That matches the README
(updated in #4354) and the engines the factory actually supports.

## Files / approach

1. `packages/cli/src/cli/index.ts`, line ~600, `export const PREREQUISITES_TEXT`: change
   ```
     - A supported coding agent CLI installed and authenticated: Claude Code, Codex, OpenCode or Pi (\`factory doctor\` shows which are ready)
   ```
   to
   ```
     - A supported coding agent CLI installed and authenticated: Claude Code, Codex, OpenCode, GitHub Copilot CLI or Pi (\`factory doctor\` shows which are ready)
   ```
   Leave the rest of the template literal unchanged. Add no comments.
2. `packages/cli/src/cli.test.ts`, around line 3389: in the test
   `'PREREQUISITES_TEXT names any supported coding agent, not only Claude Code'`, add:
   ```ts
   expect(PREREQUISITES_TEXT).toMatch(/Claude Code/);
   expect(PREREQUISITES_TEXT).toMatch(/\bPi\b/);
   expect(PREREQUISITES_TEXT).toContain('GitHub Copilot CLI');
   ```
   Keep the existing Codex and OpenCode assertions. The Copilot assertion fails before the
   change.
3. `scripts/fixtures/factory-help.txt`: run `npm run build` then
   `bash scripts/cli-help-baseline.sh --update`. Confirm the diff is only line 4. If the
   build isn't available, make the same one-line edit by hand (backticks there are literal,
   not escaped).
4. `CHANGELOG.md`: under `## Unreleased` → `### Changed`, add:
   `- \`factory --help\` now names GitHub Copilot CLI among the supported coding agent CLIs in its prerequisites (#4355)`

## Tests

- Updated test: `packages/cli/src/cli.test.ts` "PREREQUISITES_TEXT names any supported coding agent, not only Claude Code".
- Focused: `npx vitest run packages/cli/src/cli.test.ts -t "PREREQUISITES_TEXT"`.
- Baseline: `npm run build && bash scripts/cli-help-baseline.sh` exits 0.
- CHECK runs the full gate: `bash scripts/verify.sh --no-e2e`.

## Constitution compliance

- Verify gate: the help baseline fixture is regenerated so the `cli-help-baseline` step stays green. No coverage threshold changes. No skipped tests. No lint overrides.
- Tests: the colocated `cli.test.ts` is updated, and the new assertion fails without the change.
- No comments are added (ADR-0177).
- Architecture: no package boundary changes and no model ids involved.
- Docs/release: user-visible help text, so the CHANGELOG gets an Unreleased Changed entry ending in (#4355). README, docs/agents.md and docs/status.md already name Copilot or defer to agents.md, so they need no edit. No package.json version edits.
- Safety: no secrets, shell or workflow changes.
- No ADR is planned (none requested).

## Non-goals

- `factory doctor` detection or readiness logic.
- README.md and packages/cli/README.md.
- Adding or changing engine support.
- Any other `--help` text (command list, footer, env var reference).
