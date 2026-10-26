// src/phases/build-prompts.ts — BUILD prompt builders, split out of build.ts to stay under the max-lines ceiling (#3373)

import type { LintCommand } from '../checkers/index.js';
import { ENV_ERROR_PREFIX, VERIFY_SANDBOX_ENV_MARKER } from '../environment/sandbox-env.js';
import { parseSpec } from '../spec/index.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE } from '../utils/untrusted-input.js';
import { MAX_LINES_OVERRIDE_RULE } from '../run/max-lines-override.js';
import { READ_BEFORE_EDIT_RULE } from './build-lint-rules.js';

export function buildLocalSmallPrompt(opts: { issue: number; branch: string; spec: string }): string {
  const { issue, branch, spec } = opts;
  return `Local-small build for issue #${issue}.
You are in the isolated worktree for branch ${branch}.
Do one small implementation pass from this frozen spec, then commit.

Rules:
- Prefer one or two files.
- Inspect only the files you need.
- Make the smallest change that satisfies the acceptance criteria.
- Run one cheap verification command if available.
- Create exactly one git commit.
- Do not push, open a PR, or merge.
- If something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop.

${UNTRUSTED_ISSUE_BODY_NOTICE}

Frozen spec:
${compactForLocalModel(parseSpec(spec).body)}
`;
}

/** The opencode route uses the commit-only prompt verbatim (#1976). */
export function buildOpencodePrompt(opts: Parameters<typeof buildCommitOnlyPrompt>[0]): string {
  return buildCommitOnlyPrompt(opts);
}

export function buildCommitOnlyPrompt(opts: {
  issue: number;
  /** Not rendered: the spec is inlined (#1595); kept so buildPhase can share promptOpts. */
  specPath: string;
  constitutionCtx: string;
  spec: string;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
  lintCommands?: readonly LintCommand[];
  verifyCommand?: string;
  /** `tests.affected.command` template (#3260); only set when the repo opts in. */
  affectedTestsCommand?: string;
  previousAttempt?: string;
}): string {
  const {
    issue,
    constitutionCtx,
    spec,
    appPort,
    appBaseUrl,
    designGrounding,
    lintCommands,
    verifyCommand,
    affectedTestsCommand,
    previousAttempt,
  } = opts;
  return `Implement issue #${issue} from the frozen spec below. It is the approved plan: follow it and stay within its scope, with no unrelated refactors or drive-by changes.

${constitutionCtx}

${UNTRUSTED_ISSUE_BODY_NOTICE}

## Spec
${parseSpec(spec).body.trim()}

${previousAttempt ? `${previousAttempt}\n\n` : ''}## Rules
- ${READ_BEFORE_EDIT_RULE}
- Match the surrounding code style. Add or update the tests in the spec's Tests section.
- ${verifyRule(lintCommands, verifyCommand, affectedTestsCommand)}
- ${MAX_LINES_OVERRIDE_RULE}
- Commit atomically: one commit per independently testable functional change, with a clear conventional message. Never mix unrelated functional changes in one commit. A single-slice task yields exactly ONE commit.
- Do NOT push, do NOT open a pull request, do NOT merge. CHECK and SHIP run next.
- If something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop. If you are stuck, commit what safely builds and passes, say what is blocked in the commit message, and stop.
- Work directly. Use sub-agents only for genuinely independent work.

${promptTail(appPort, appBaseUrl, designGrounding)}`;
}

export function buildClaudePrompt(opts: {
  issue: number;
  branch: string;
  specPath: string;
  constitutionCtx: string;
  skipCI?: boolean;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
  lintCommands?: readonly LintCommand[];
  verifyCommand?: string;
  /** `tests.affected.command` template (#3260); only set when the repo opts in. */
  affectedTestsCommand?: string;
  previousAttempt?: string;
}): string {
  const { previousAttempt } = opts;
  const {
    issue,
    branch,
    specPath,
    constitutionCtx,
    skipCI,
    appPort,
    appBaseUrl,
    designGrounding,
    lintCommands,
    verifyCommand,
    affectedTestsCommand,
  } = opts;
  return `Run fully autonomously in headless mode for issue #${issue}, BUILD phase.
You are ALREADY inside the isolated git worktree for branch ${branch} (cwd). Nobody is watching: never pause for permission or input.

${constitutionCtx}

The frozen, approved spec is at ${specPath}. Read it and follow it as the plan. Do not re-plan from the issue or wait on a plan gate. Stay within its scope. Auto-fix only high-confidence review findings. For uncertain ones, apply the conservative default and note the deferral in the PR body.

${UNTRUSTED_ISSUE_BODY_NOTICE}

${previousAttempt ? `${previousAttempt}\n\n` : ''}- ${READ_BEFORE_EDIT_RULE}
- ${verifyRule(lintCommands, verifyCommand, affectedTestsCommand)}
- ${MAX_LINES_OVERRIDE_RULE}
- Commit atomically: one commit per independently testable functional change, with a clear conventional message. Never mix unrelated functional changes in one commit.
- Do NOT merge (the factory merges). Your session ends when you end your turn, so do not stop until: (1) branch ${branch} is pushed, (2) an open PR exists with 'Closes #${issue}' in its body, ${skipCI ? '(3) local verify passes (CI is intentionally skipped: do not block on GitHub Actions CI or escalate if CI cannot run), (4) the PR is ready.' : '(3) CI is green, (4) the PR is ready.'}
- If and only if something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop.

${promptTail(appPort, appBaseUrl, designGrounding)}`;
}

// Mirrors testsChecker's command order so BUILD verifies with what CHECK runs (#1976).
const VERIFY_RULE_BASE =
  'Verify with the command CHECK runs: `bash scripts/verify.sh --no-e2e` if scripts/verify.sh exists, ' +
  'otherwise the test script (`npm test`) or pytest, plus any verify command the constitution names. ' +
  'Fix failures before finishing and report the exact command and its output.' +
  ` If verify.sh prints \`${VERIFY_SANDBOX_ENV_MARKER}\` (exit 78), that is a sandbox environment error, not a code failure: do not re-run verify.sh or work around it (no TMPDIR or port changes); print a line starting \`${ENV_ERROR_PREFIX}\` followed by that line, then stop.`;

// Names the lint checker's commands (resolveLintCommands) when the repo has no verify.sh (#2829);
// a verifyCommand (verify.ps1-only repo, #3471) replaces the base with the pwsh command CHECK runs.
function verifyRule(
  lintCommands: readonly LintCommand[] = [],
  verifyCommand?: string,
  affectedTestsCommand?: string,
): string {
  const base = verifyCommand
    ? `Verify with the command CHECK runs: \`${verifyCommand}\` (this repo's gate is scripts/verify.ps1), plus any verify command the constitution names. Fix failures before finishing and report the exact command and its output.`
    : VERIFY_RULE_BASE;
  const affected = affectedTestsCommand
    ? ` While iterating, you may run only the affected tests with \`${affectedTestsCommand}\` ({files} = the paths you changed, each shell-quoted); CHECK runs the full suite before SHIP, so finish with the full command above.`
    : '';
  if (lintCommands.length === 0) return `${base}${affected}`;
  const cmds = lintCommands.map((c) => `\`${c.argv.join(' ')}\``).join(' and ');
  return `${base} Also run ${cmds} (CHECK's lint checker runs them) and fix their failures before finishing.${affected}`;
}

function promptTail(appPort?: number, appBaseUrl?: string, designGrounding?: string): string {
  return `${headlessNote()}${appPort ? `\n\n${appPortNote(appPort, appBaseUrl)}` : ''}${designGrounding ? `\n\n${designGrounding}` : ''}`;
}

function headlessNote(): string {
  return `## Headless e2e (factory-managed run)
FACTORY_HEADLESS=1 and PLAYWRIGHT_HEADLESS=1 are set: never open a visible browser window. Any e2e or browser-runner config you write (Playwright, Cypress, etc.) must stay headless by default (keep \`headless: true\` or omit it), and never bake \`--headed\`, \`--ui\`, or \`cypress open\` into package.json scripts.`;
}

function appPortNote(appPort: number, appBaseUrl?: string): string {
  const baseUrlSentence = appBaseUrl
    ? `This lane owns port ${appPort}; its stable base URL is ${appBaseUrl} (via the factory proxy).`
    : `This lane owns port ${appPort} (base URL http://127.0.0.1:${appPort}).`;
  return `## Assigned app port
${baseUrlSentence} PORT and FACTORY_APP_PORT are set. Dev servers, previews and e2e config must read process.env.PORT (never hardcode 3000) and use a strict port (Vite: --strictPort; Next.js: -p ${appPort}) so a mismatch fails loudly.`;
}

function compactForLocalModel(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 6000) return trimmed;
  return `${trimmed.slice(0, 5600)}\n\n[truncated for local model: keep the implementation minimal and inspect files as needed]`;
}
