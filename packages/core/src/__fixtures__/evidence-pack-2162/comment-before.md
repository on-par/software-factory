## 🔎 Evidence pack

Checkers: 7 pass, 0 fail, 0 skip · Rework rounds: 0

<details>
<summary>Checker verdicts</summary>

- ✅ PASS `worker_output` — worker produced a diff against origin/main
- ✅ PASS `compile` — npm run build: OK
- ✅ PASS `tests` — scripts/verify.sh: OK
- ✅ PASS `lint` — lint: OK; tsc: OK
- ✅ PASS `links` — checked 4 links, all OK
- ✅ PASS `accessibility` — basic checks passed (alt, placeholder links) — scanned 2 HTML files
- ✅ PASS `design_smells` — no program-design smells found in the diff

</details>

<details>
<summary>Frozen spec</summary>

None of the `@on-par/*` packages are on npm yet, so the README's lead install command (`npm install -g @on-par/factory-cli`) fails. This change makes the clone + local install + `npm link` path the primary Quick Start install. The global install moves into a clearly non-primary "after Wave-1 publish" note that links #1566 and #1560.

</details>

<details>
<summary>Design artifact</summary>

## Design artifact (#2149)

### Restated problem

README.md's "Quick Start (5 minutes)" Step 1 leads with `npm install -g @on-par/factory-cli`, but no @on-par/* package is published on npm yet, so a visitor's first command 404s. The clone-and-link path that actually works is shown only as a secondary "Development alternative". Step 1 must make clone + `npm install` + `npm run build` + `npm link` the primary install path, and demote the global registry install to a clearly labelled "after Wave-1 publish" note that points to epic #1566 and blocker #1560.

### Approach

Edit only the Step 1 block of the README Quick Start. Make the existing clone/build/link commands (plus `factory --version` to confirm the binary) the lead code block. Below it, add a short blockquote note saying the @on-par/* packages are not yet published on npm, that `npm install -g @on-par/factory-cli` will work only after the Wave-1 publish (#1566, blocked on #1560), and show that command inside the note so it is clearly non-primary.

Rejected:

- **Delete every mention of `npm install -g @on-par/factory-cli`** — Readers coming back after publish would lose the eventual path. A labelled "after publish" note satisfies the acceptance criteria and keeps the intent visible.
- **Rewrite the wider README hero, status, or monorepo sections** — Out of scope. Sibling issues cover those changes.

### Interfaces touched

- README.md (Quick Start, Step 1 — Install)

### Target types

_None recorded._

### Key signatures

_None recorded._

### Call graph

_None recorded._

### Behavior contract

- The first install code block in Quick Start clones the repo, runs `npm install`, `npm run build`, `npm link --workspace @on-par/factory-cli`, and checks `factory --version`.
- `npm install -g @on-par/factory-cli` appears only inside a note marked as available after the Wave-1 publish, never as the lead Quick Start command.
- The README says the @on-par/* packages are not yet published and references

### Verification plan

- `rg -n -i 'quick start|npm link|clone' README.md | head -40` — pass when: The Quick Start heading is followed by the `git clone` and `npm link --workspace @on-par/factory-cli` lines in Step 1.
- `rg -n 'npm install -g @on-par/factory-cli' README.md || true` — pass when: Zero matches, or only a match inside the "after Wave-1 publish" note that comes after the primary clone block.
- `rg -n '1566|1560|Wave-1|not yet published' README.md` — pass when: At least one match in the Quick Start Step 1 note that references
- `bash scripts/verify.sh --no-e2e` — pass when: Exits 0. No code changed, so this confirms nothing else regressed.

### Risk / blast radius

Documentation only. The worst case is a misleading or broken install instruction in the README. No code, tests, coverage, or CI behavior changes.

### Open questions

_None._


</details>

<details>
<summary>Rework & verification</summary>

- Rework rounds: 0
- check: Running checkers
- check: All checkers passed
- ship: remote head 32a38489d5a3d63b9efe35dfecf5a4724ca57170 matches local HEAD 32a38489d5a3d63b9efe35dfecf5a4724ca57170 for factory/2149-readme-quick-start-must-not-clai
- Final result: all checkers passed

</details>

<details>
<summary>Event timeline</summary>

- 2026-10-06T14:16:25.708Z issue-title: README: Quick Start must not claim npm global install until Wave-1 publish works
- 2026-10-06T14:16:25.709Z model-override: plan model pinned to claude-opus-5-5 (.factory/config.json)
- 2026-10-06T14:16:25.709Z model-override: build model pinned to claude-sonnet-5-5 (.factory/config.json)
- 2026-10-06T14:16:25.713Z sandbox-degraded: host-level egress filtering unavailable in v1; intended allowlist: api.anthropic.com, github.com
- 2026-10-06T14:16:27.302Z worktree-base: created from origin/main @ 47c4fbc6b15605f70a13b9082f0047bd6fd2c112
- 2026-10-06T14:16:27.303Z worktree: Worktree ready at /Users/moltbot/.factory/worktrees/on-par/software-factory/software-factory-factory-factory-2149
- 2026-10-06T14:16:27.304Z environment_lease: leased port 3101 for worktree /Users/moltbot/.factory/worktrees/on-par/software-factory/software-factory-factory-factory-2149
- 2026-10-06T14:16:27.305Z constitution: Standards from repo instruction files
- 2026-10-06T14:16:27.306Z model-override: build route derived from pinned build model claude-sonnet-5-5 → claude
- 2026-10-06T14:16:27.306Z phase_started: plan started
- 2026-10-06T14:16:27.645Z work_request: resolved work request github-issue:on-par/software-factory#2149 (github-issue, 4 acceptance criteria)
- 2026-10-06T14:16:27.648Z plan: Starting plan phase
- 2026-10-06T14:16:27.649Z readiness: issue readiness 100% (factory-task)
- 2026-10-06T14:16:27.650Z adr_inject_started: reading accepted ADRs for design-constraint injection
- 2026-10-06T14:16:28.035Z adr_context: 20 accepted ADR(s) injected as design constraints: ADR-0135, ADR-0136, ADR-0137, ADR-0138, ADR-0139, ADR-0140, ADR-0141, ADR-0142, ADR-0143, ADR-0144, ADR-0145, ADR-0146, ADR-0147, ADR-0148, ADR-0149, ADR-0150, ADR-0151, ADR-0153, ADR-0154, ADR-0155 (126 more omitted by the injection cap)
- 2026-10-06T14:16:28.041Z adr_skipped: 9 ADR file(s) skipped (not Accepted or unparsable)
- 2026-10-06T14:16:28.050Z adr_inject_completed: ADR injection complete (20 active)
- 2026-10-06T14:16:28.056Z router: Trying claude-opus-5-5 for plan (attempt 1)
- 2026-10-06T14:17:06.547Z design_artifact_emitted: design artifact validated and written (open questions: 0, target types: 0, signatures: 0, call edges: 0)
- 2026-10-06T14:17:06.549Z design_shallow: design artifact has no targetTypes, signatures, or callGraph — BUILD will run without design grounding
- 2026-10-06T14:17:06.550Z plan: Plan complete with model claude-opus-5-5, route: claude
- 2026-10-06T14:17:06.551Z phase_completed: plan complete (route claude, model claude-opus-5-5)
- 2026-10-06T14:17:06.555Z phase_started: build started
- 2026-10-06T14:17:06.556Z design_artifact_received: design artifact received (open questions: 0, target types: 0, signatures: 0, call edges: 0)
- 2026-10-06T14:17:06.557Z build: Starting build phase (route: claude)
- 2026-10-06T14:17:06.557Z sandbox: containment active (runtime sandbox-exec, net allow-list)
- 2026-10-06T14:17:06.922Z router: Trying claude-sonnet-5-5 for build_claude (attempt 1)
- 2026-10-06T14:22:37.945Z build: Build complete with model claude-sonnet-5-5
- 2026-10-06T14:22:37.947Z phase_completed: build complete (model claude-sonnet-5-5)
- 2026-10-06T14:22:37.950Z phase_started: check started
- 2026-10-06T14:22:37.981Z check: Running checkers
- 2026-10-06T14:22:37.982Z checker_started: checker worker_output started
- 2026-10-06T14:22:38.025Z checker_completed: checker worker_output completed (PASS)
- 2026-10-06T14:22:38.027Z checker_started: checker compile started
- 2026-10-06T14:22:38.837Z checker_completed: checker compile completed (PASS)
- 2026-10-06T14:22:38.840Z checker_started: checker tests started
- 2026-10-06T14:25:42.087Z checker_completed: checker tests completed (PASS)
- 2026-10-06T14:25:42.091Z checker_started: checker lint started
- 2026-10-06T14:25:44.482Z checker_completed: checker lint completed (PASS)
- 2026-10-06T14:25:44.483Z checker_started: checker links started
- 2026-10-06T14:25:44.485Z checker_completed: checker links completed (PASS)
- 2026-10-06T14:25:44.486Z checker_started: checker accessibility started
- 2026-10-06T14:25:44.487Z checker_completed: checker accessibility completed (PASS)
- 2026-10-06T14:25:44.488Z checker_started: checker design_smells started
- 2026-10-06T14:25:49.078Z checker_completed: checker design_smells completed (PASS)
- 2026-10-06T14:25:49.079Z check: All checkers passed
- 2026-10-06T14:25:49.079Z phase_completed: check passed (7 pass, 0 fail, 0 rework rounds)
- 2026-10-06T14:25:49.081Z phase_started: ship started
- 2026-10-06T14:25:53.746Z ship: remote head 32a38489d5a3d63b9efe35dfecf5a4724ca57170 matches local HEAD 32a38489d5a3d63b9efe35dfecf5a4724ca57170 for factory/2149-readme-quick-start-must-not-clai
- 2026-10-06T14:25:55.845Z recovered: opened PR #2162 for committed work on factory/2149-readme-quick-start-must-not-clai

</details>

<details>
<summary>Logs</summary>

- No per-issue log files found; see the event timeline above.

</details>

