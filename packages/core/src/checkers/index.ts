import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { ReviewFloorRuleSet } from '../review/floor.js';
import type { ModelRouter } from '../router/index.js';
import type { ProcessGroupTracker } from '../environment/process-groups.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { CheckerOutput, CheckSummary, Constitution, RegressionFinding } from '../types/index.js';
import { type CommandResult, type RunCommandOptions } from '../utils/command-runner.js';
import { runVerificationCommand as runCommand } from './run-command.js';
import type { QaConfig } from '../config/qa-section.js';
import type { ChecksConfig } from '../config/checks-section.js';
import {
  describeChecksProbe,
  resolveCompileCommand,
  resolveLintCommands,
  resolveTestsCommand,
} from './resolve-commands.js';
import type { LintCommand, PackageJson } from './resolve-commands.js';
import { isTemplateToken } from '../config/template-tokens.js';
import { extractJsonObjects } from '../utils/json.js';
import { APP_SMOKE_CHECKER, appSmokeChecker } from './app-smoke.js';
import { sandboxEnvMarkerLine } from '../environment/sandbox-env.js';
import { writeCommandLog } from './command-log.js';
import {
  extractLintFindings,
  formatLintFindings,
  resolveLintDiff,
  scopeLintCommand,
  withMergeBaseWorktree,
  type LintScope,
} from './lint-scope.js';
import {
  combinedOutputTail,
  describeCommandFailureTail,
  describeTestFailure,
  extractFailedTestEvidence,
  parseCommandCounts,
} from './command-output.js';
import { type AffectedTestsResolution, describeAffectedResolution } from './affected-tests.js';

export { writeCommandLog };
import {
  DESIGN_SMELLS_CHECKER,
  designSmellsChecker,
  workerOutputChecker,
  WORKER_OUTPUT_CHECKER,
} from './design-smells.js';
import { startResourceMeter } from '../utils/resource-usage.js';
import { countPlaceholderLinks, fileExists, findHtmlFiles, probeWorktree, type WorktreeProbe } from './probe.js';

export type { WorktreeProbe } from './probe.js';
export {
  describeChecksProbe,
  getPackageJson,
  resolveCompileCommand,
  resolveLintCommands,
  resolveTestsCommand,
  VERIFY_PS1_ARGV,
  type LintCommand,
  type TestsCommand,
} from './resolve-commands.js';
export { probeWorktree } from './probe.js';

export interface CheckerContext {
  sandbox?: SandboxPolicy;
  worktree: string;
  specPath: string;
  qa?: QaConfig | null;
  checks?: ChecksConfig | null;
  diffBase?: string;
  parentBaseRef?: string;
  reviewFloorRules?: ReviewFloorRuleSet;
  constitutionBody?: string;
  packageJson?: PackageJson | null;
  testsRequired?: boolean;
  probe?: WorktreeProbe;
  probeWorktree?: (worktree: string) => Promise<WorktreeProbe>;
  runCommand?: (argv: readonly string[], options?: RunCommandOptions) => Promise<CommandResult>;
  env?: Record<string, string>;
  onPgid?: (pgid: number) => void;
  processGroupTracker?: Pick<ProcessGroupTracker, 'killAll'>;
  log?: (type: EventKind, msg: string, extra?: { durationMs?: number; cpuMs?: number; peakRssBytes?: number }) => void;
  onActivity?: () => void | Promise<void>;
  outputLogDir?: string;
  testsTimeoutSeconds?: number;
  compileTimeoutSeconds?: number;
  affectedTests?: AffectedTestsResolution & { round: number };
}

export type CheckerFn = (ctx: CheckerContext) => Promise<CheckerOutput>;

export interface Checker {
  name: string;
  run(ctx: CheckerRunCtx): Promise<CheckerOutput>;
}

export interface CheckerRunCtx extends CheckerContext {
  router: ModelRouter;
  timeoutSeconds?: number;
}

const DEFAULT_COMPILE_TIMEOUT_SECONDS = 120;
export const compileChecker: CheckerFn = async (ctx) => {
  const run = ctx.runCommand ?? runCommand;
  const timeoutSeconds = ctx.compileTimeoutSeconds ?? DEFAULT_COMPILE_TIMEOUT_SECONDS;
  const timeoutMs = timeoutSeconds * 1000;
  const evidence = (r: CommandResult): string => {
    const tail = describeCommandFailureTail(r, 500);
    if (!r.timedOut) return tail;
    const head = `timed out after ${timeoutSeconds}s (raise timeouts.compile_seconds or FACTORY_COMPILE_TIMEOUT)`;
    return tail === 'timed out' ? head : `${head}\n${tail}`;
  };
  try {
    const argv = (await resolveCompileCommand(ctx))?.argv;
    if (!argv) {
      const probed = `no checks.build in ${describeChecksProbe(ctx)}, no package.json build or typecheck script, Makefile or Cargo.toml`;
      return { checker: 'compile', result: 'SKIP', details: `no build system detected (${probed}) — skipped` };
    }

    const label = argv.join(' ');
    const r = await run(argv, { cwd: ctx.worktree, timeoutMs, env: ctx.env, onPgid: ctx.onPgid });
    if (r.ok) return { checker: 'compile', result: 'PASS', details: `${label}: OK` };
    return {
      checker: 'compile',
      result: 'FAIL',
      details: await commandFailureDetails(ctx, 'compile', label, r, evidence(r)),
      ...(r.timedOut ? { timedOut: true } : {}),
      failedCommand: { command: label, exitCode: r.exitCode, timeoutSeconds },
    };
  } catch (e: any) {
    return {
      checker: 'compile',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
      checkerError: true,
    };
  }
};

async function commandFailureDetails(
  ctx: CheckerContext,
  checker: string,
  label: string,
  r: CommandResult,
  summary: string,
): Promise<string> {
  const logPath = await writeCommandLog(ctx, `${checker}-${label}`, r);
  return logPath ? `${label} failed: ${summary}\nfull output: ${logPath}` : `${label} failed: ${summary}`;
}

const TESTS_PASS_DETAILS = {
  config: 'checks.test: OK',
  verify: 'scripts/verify.sh: OK',
  'verify-ps1': 'scripts/verify.ps1: OK',
  npm: 'npm test: OK',
  pytest: 'python3 -m pytest: OK',
} as const;

const DEFAULT_TESTS_TIMEOUT_SECONDS = 300;

const SHELL_COMMAND_NOT_FOUND_EXIT = 127;

async function onPath(bin: string, env?: NodeJS.ProcessEnv): Promise<boolean> {
  const names = process.platform === 'win32' ? [bin, `${bin}.exe`] : [bin];
  for (const dir of (env?.PATH ?? process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) if (await fileExists(join(dir, name))) return true;
  }
  return false;
}

const runFullTests: CheckerFn = async (ctx) => {
  try {
    const run = ctx.runCommand ?? runCommand;
    const timeoutSeconds = ctx.testsTimeoutSeconds ?? DEFAULT_TESTS_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    const arrivalOrderTail = combinedOutputTail();
    const describeFailure = (r: CommandResult): string => {
      const evidence = describeTestFailure(r, 500, arrivalOrderTail.text());
      if (!r.timedOut) return evidence;
      const head = `timed out after ${timeoutSeconds}s (raise timeouts.tests_seconds or FACTORY_TESTS_TIMEOUT)`;
      return evidence === 'timed out' ? head : `${head}\n${evidence}`;
    };
    const cmd = await resolveTestsCommand(ctx);
    if (cmd.runner === 'verify-ps1' && !(await onPath('pwsh', ctx.env))) {
      return {
        checker: 'tests',
        result: 'FAIL',
        details:
          'verify.ps1 failed: pwsh (PowerShell 7) is not on PATH — scripts/verify.ps1 needs it. Install PowerShell: https://aka.ms/powershell (macOS: brew install --cask powershell; Linux: see the same page).',
        failedCommand: {
          command: cmd.argv.join(' '),
          exitCode: SHELL_COMMAND_NOT_FOUND_EXIT,
          timeoutSeconds,
        },
      };
    }
    if (cmd.runner !== 'none') {
      const r = await run(cmd.argv, {
        cwd: ctx.worktree,
        timeoutMs,
        env: ctx.env,
        onPgid: ctx.onPgid,
        onOutput: arrivalOrderTail.onOutput,
      });
      if (r.ok) return { checker: 'tests', result: 'PASS', details: TESTS_PASS_DETAILS[cmd.runner] };
      const marker = sandboxEnvMarkerLine(r);
      return {
        checker: 'tests',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'tests', cmd.label, r, describeFailure(r)),
        ...(r.timedOut ? { timedOut: true } : {}),
        ...(marker ? { sandboxEnv: marker } : {}),
        failedCommand: { command: cmd.argv.join(' '), exitCode: r.exitCode, timeoutSeconds },
      };
    }

    if (ctx.testsRequired) {
      return {
        checker: 'tests',
        result: 'FAIL',
        details: `no verification command was run — constitution requires tests (requireTests: true) but there is no checks.test in ${describeChecksProbe(ctx)} and the worktree has no pytest, scripts/verify.sh, scripts/verify.ps1, or npm-test surface (run \`factory init --detect-checks\`)`,
      };
    }
    return {
      checker: 'tests',
      result: 'SKIP',
      details: `no verification command was run — no checks.test in ${describeChecksProbe(ctx)}, no scripts/verify.sh, no scripts/verify.ps1 and no package.json test script found`,
    };
  } catch (e: any) {
    return {
      checker: 'tests',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
      checkerError: true,
    };
  }
};

async function runAffected(ctx: CheckerContext, argv: readonly string[]): Promise<CommandResult | undefined> {
  const timeoutSeconds = ctx.testsTimeoutSeconds ?? DEFAULT_TESTS_TIMEOUT_SECONDS;
  try {
    return await (ctx.runCommand ?? runCommand)(argv, {
      cwd: ctx.worktree,
      timeoutMs: timeoutSeconds * 1000,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
  } catch {
    return undefined;
  }
}

export const testsChecker: CheckerFn = async (ctx) => {
  const sel = ctx.affectedTests;
  if (sel?.kind !== 'affected') return runFullTests(ctx);
  const r = await runAffected(ctx, sel.argv);
  if (r) {
    const output = `${r.stdout}\n${r.stderr}`;
    const counts = parseCommandCounts(output);
    if (r.ok && counts && (counts.passed ?? 0) > 0 && !counts.failed) {
      return { checker: 'tests', result: 'PASS', details: `affected tests: OK (${counts.line}) — ${sel.command}` };
    }
    if (!r.ok && !r.timedOut && extractFailedTestEvidence(output) !== null) {
      return {
        checker: 'tests',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'tests', 'affected', r, describeTestFailure(r, 500)),
      };
    }
  }
  const fallback: AffectedTestsResolution = {
    kind: 'full',
    reason: r?.ok ? 'zero-tests' : 'tool-error',
    fileCount: sel.fileCount,
  };
  ctx.log?.('affected_tests', describeAffectedResolution(fallback, sel.round));
  return runFullTests(ctx);
};

export const lintChecker: CheckerFn = async (ctx) => {
  let commands: LintCommand[];
  try {
    commands = await resolveLintCommands(ctx);
  } catch (e: any) {
    return {
      checker: 'lint',
      result: 'FAIL',
      details: `unexpected checker error: ${String(e?.message ?? e).slice(0, 500)}`,
      checkerError: true,
    };
  }
  if (commands.length === 0) {
    const probed = `no checks.lint in ${describeChecksProbe(ctx)}, no package.json lint script, no tsconfig.json`;
    return { checker: 'lint', result: 'SKIP', details: `no linting configured (${probed}) — skipped` };
  }

  const run = ctx.runCommand ?? runCommand;
  const opts = { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env, onPgid: ctx.onPgid };
  const diff = await resolveLintDiff(ctx);
  const details: string[] = [];
  const findingsOf = (r: CommandResult) =>
    formatLintFindings(extractLintFindings(`${r.stdout}\n${r.stderr}`, ctx.worktree));
  let failed = false;
  let ran = false;
  const fail = async (cmd: LintCommand, r: CommandResult, lead?: string) => {
    failed = true;
    const summary = await commandFailureDetails(ctx, 'lint', cmd.label, r, describeCommandFailureTail(r, 300));
    details.push(lead === undefined ? summary : `${lead}; ${summary}`);
  };
  const withFindings = (r: CommandResult, lead: string) => {
    const found = findingsOf(r);
    return found === '' ? lead : `${lead} — ${found}`;
  };
  const preExisting = async (cmd: LintCommand, r: CommandResult, mergeBase: string) => {
    const log = await writeCommandLog(ctx, `lint-${cmd.label}`, r);
    const what = findingsOf(r) || describeCommandFailureTail(r, 300);
    const head = `${cmd.label}: OK — warning: pre-existing ${cmd.label} failures on merge base ${mergeBase.slice(0, 7)}: ${what}`;
    details.push(log ? `${head}\nfull output: ${log}` : head);
  };

  const queued: { cmd: LintCommand; argv: string[]; r: CommandResult }[] = [];
  for (const cmd of commands) {
    const scope: LintScope =
      'unavailable' in diff ? { kind: 'whole', argv: cmd.argv, profile: null } : scopeLintCommand(cmd, diff.changed);
    if (scope.kind === 'skip' || scope.kind === 'write-mode') {
      details.push(scope.reason);
      continue;
    }
    ran = true;
    const r = await run(scope.argv, opts);
    if (r.ok) {
      details.push(
        scope.kind === 'files' ? `${cmd.label}: OK (${scope.files.length} changed files)` : `${cmd.label}: OK`,
      );
    } else if (scope.kind === 'files') {
      await fail(cmd, r, withFindings(r, `${cmd.label}: new findings in changed files`));
    } else if ('unavailable' in diff || r.timedOut) {
      await fail(cmd, r);
    } else if (diff.changed.length === 0) {
      await preExisting(cmd, r, diff.mergeBase);
    } else {
      queued.push({ cmd, argv: scope.argv, r });
    }
  }
  if (!('unavailable' in diff) && queued.length > 0) {
    const base = await withMergeBaseWorktree(
      { laneWorktree: ctx.worktree, mergeBase: diff.mergeBase, env: ctx.env, run },
      async (dir) => {
        const results: CommandResult[] = [];
        for (const q of queued) results.push(await run(q.argv, { ...opts, cwd: dir }));
        return results;
      },
    );
    for (const [i, { cmd, r }] of queued.entries()) {
      const baseRun = base.ok ? base.value[i]! : null;
      if (baseRun === null || baseRun.timedOut) {
        const why = baseRun === null && !base.ok ? base.error : 'merge-base run timed out';
        await fail(cmd, r, `${cmd.label} failed; merge-base comparison inconclusive (${why})`);
      } else if (baseRun.ok) {
        await fail(
          cmd,
          r,
          withFindings(r, `${cmd.label}: new findings (merge base ${diff.mergeBase.slice(0, 7)} passes)`),
        );
      } else {
        await preExisting(cmd, r, diff.mergeBase);
      }
    }
  }
  if (failed && 'unavailable' in diff) details.push(`changed files unknown (${diff.unavailable}) — whole-repo result`);

  const result: CheckerOutput['result'] = failed ? 'FAIL' : ran ? 'PASS' : 'SKIP';
  return { checker: 'lint', result, details: details.join('; ') };
};

export const linksChecker: CheckerFn = async (ctx) => {
  const files = ctx.probe?.htmlFiles ?? (await findHtmlFiles(ctx.worktree));

  if (files.length === 0) {
    return { checker: 'links', result: 'PASS', details: 'no HTML files — skipped' };
  }

  const urls = new Set<string>();
  let broken = 0;

  for (const rel of files) {
    const html = await readFile(join(ctx.worktree, rel), 'utf-8').catch(() => '');

    for (const match of html.matchAll(/(?:href|src)=["']([^"'#]*)/g)) {
      const url = match[1];
      if (!url || /^(mailto:|tel:|javascript:|data:)/.test(url)) continue;
      urls.add(url);
    }

    broken += countPlaceholderLinks(html);
  }

  const checked = urls.size;

  return {
    checker: 'links',
    result: broken > 0 ? 'FAIL' : 'PASS',
    details: broken > 0 ? `${broken} placeholder href="#" links found` : `checked ${checked} links, all OK`,
    linksChecked: checked,
    broken,
  };
};

const MAX_ACCESSIBILITY_FILES = 20;

export const accessibilityChecker: CheckerFn = async (ctx) => {
  const allFiles = ctx.probe?.htmlFiles ?? (await findHtmlFiles(ctx.worktree));

  if (allFiles.length === 0) {
    return { checker: 'accessibility', result: 'PASS', details: 'no HTML files — skipped' };
  }

  const files = allFiles.slice(0, MAX_ACCESSIBILITY_FILES);
  const unscanned = allFiles.length - files.length;

  let issues = 0;
  const details: string[] = [];

  for (const rel of files) {
    const html = await readFile(join(ctx.worktree, rel), 'utf-8').catch(() => '');

    const imgNoAlt = (html.match(/<img[^>]*>/g) ?? []).filter((t) => !t.includes('alt=')).length;
    if (imgNoAlt > 0) {
      issues += imgNoAlt;
      details.push(`${rel}: ${imgNoAlt} images without alt`);
    }

    const ph = countPlaceholderLinks(html);
    if (ph > 0) {
      issues += ph;
      details.push(`${rel}: ${ph} placeholder links`);
    }
  }

  const coverage =
    unscanned > 0
      ? `scanned first ${files.length} of ${allFiles.length} HTML files (${unscanned} not scanned)`
      : `scanned ${files.length} HTML files`;

  return {
    checker: 'accessibility',
    result: issues > 0 ? 'FAIL' : 'PASS',
    details:
      details.length > 0
        ? `${coverage}; ${details.join('; ')} (note: browser-based axe-core recommended for full WCAG)`
        : `basic checks passed (alt, placeholder links) — ${coverage}`,
  };
};

function isCustomCheckerVerdict(
  value: unknown,
  checkerName: string,
): value is { checker: string; result: 'PASS' | 'FAIL'; details: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.checker === checkerName && (v.result === 'PASS' || v.result === 'FAIL') && typeof v.details === 'string';
}

export async function runCustomChecker(
  ctx: CheckerContext,
  checkerName: string,
  router: ModelRouter,
  timeoutSeconds?: number,
): Promise<CheckerOutput> {
  const prompt = `You are a CHECKER agent for a software factory. Your job is to independently
verify the work in the worktree against a specific standard. Do NOT trust the worker's
self-report — verify directly.

WORKTREE: ${ctx.worktree}
CHECKER NAME: ${checkerName}
SPEC: ${await readFile(ctx.specPath, 'utf-8').catch(() => '(no spec)')}

CONSTITUTION (the written standard):
${ctx.constitutionBody ?? '(none)'}

Your job: Run the '${checkerName}' check. This is a custom checker defined in the
constitution above. Find the relevant standard in the constitution and verify the
work in the worktree against it.

Steps:
1. Read the constitution to understand what '${checkerName}' should verify.
2. Inspect the worktree files relevant to this check.
3. Run any necessary commands (lint, build, test, grep, etc.) to verify.
4. Return a JSON verdict on stdout (and ONLY the JSON):
{"checker":"${checkerName}","result":"PASS or FAIL","details":"<specific findings>"}`;

  try {
    const result = await router.run('check_custom', prompt, {
      worktree: ctx.worktree,
      sandbox: ctx.sandbox,
      timeoutSeconds: timeoutSeconds ?? 1800,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    const candidates = extractJsonObjects(result.output);
    const verdictCandidate = candidates.find(
      (c) =>
        typeof c.value === 'object' &&
        c.value !== null &&
        !Array.isArray(c.value) &&
        'checker' in (c.value as Record<string, unknown>),
    );
    if (verdictCandidate) {
      if (isCustomCheckerVerdict(verdictCandidate.value, checkerName)) {
        return { checker: checkerName, result: verdictCandidate.value.result, details: verdictCandidate.value.details };
      }
      return {
        checker: checkerName,
        result: 'FAIL',
        details: `checker returned a malformed verdict: ${verdictCandidate.text.slice(0, 200)}`,
      };
    }
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker produced no valid JSON: ${result.output.slice(0, 200)}`,
    };
  } catch (e: any) {
    return {
      checker: checkerName,
      result: 'FAIL',
      details: `checker agent failed: ${(e?.stderr || e?.message || String(e)).slice(0, 300)}`,
    };
  }
}

const BUILT_IN_CHECKERS: readonly (Checker & { description: string; optIn?: boolean })[] = [
  {
    name: WORKER_OUTPUT_CHECKER,
    run: (ctx) => workerOutputChecker(ctx),
    description: 'FAILs when the worker produced no diff against the base',
  },
  {
    name: 'compile',
    run: (ctx) => compileChecker(ctx),
    description: "runs the repo's build/typecheck script",
  },
  {
    name: 'tests',
    run: (ctx) => testsChecker(ctx),
    description: "runs the repo's verify or test command (FAILs instead of SKIPs with requireTests)",
  },
  {
    name: 'lint',
    run: (ctx) => lintChecker(ctx),
    description: "runs the repo's lint and format commands on the change; fails only on new findings",
  },
  {
    name: 'links',
    run: (ctx) => linksChecker(ctx),
    description: 'checks href/src links in generated HTML files resolve',
  },
  {
    name: 'accessibility',
    run: (ctx) => accessibilityChecker(ctx),
    description: 'runs accessibility checks on generated HTML',
  },
  {
    name: DESIGN_SMELLS_CHECKER,
    run: (ctx) => designSmellsChecker(ctx, ctx.router, ctx.timeoutSeconds),
    description: 'model-judged review of the diff for design smells',
  },
  {
    name: APP_SMOKE_CHECKER,
    run: (ctx) => appSmokeChecker(ctx),
    description: 'opt-in: starts the app on the lane port (qa.start) and runs qa.smoke',
    optIn: true,
  },
];

export interface BuiltInCheckerInfo {
  name: string;
  description: string;
}

export function listBuiltInCheckers(): BuiltInCheckerInfo[] {
  return BUILT_IN_CHECKERS.map(({ name, description }) => ({ name, description }));
}

export const STANDARD_CHECKER_NAMES = BUILT_IN_CHECKERS.map((c) => c.name);

const UNKNOWN_CHECKER_PREFIX = 'unknown checker ';

export function unknownCheckerOutput(name: string): CheckerOutput {
  return {
    checker: name,
    result: 'FAIL',
    details: `${UNKNOWN_CHECKER_PREFIX}'${name}' — not a built-in (${STANDARD_CHECKER_NAMES.join(', ')}) and not a custom_* agent checker; failing closed so the declared standard is not silently skipped`,
  };
}

export function isUnknownCheckerOutput(output: CheckerOutput): boolean {
  return output.result === 'FAIL' && output.details.startsWith(UNKNOWN_CHECKER_PREFIX);
}

const SCHEMA_ERROR_PREFIX = 'config schema error: ';
const UNFILLED_PLACEHOLDER_PREFIX = 'unfilled placeholder ';

export function schemaErrorCheckerOutput(name: string, problem: string): CheckerOutput {
  return {
    checker: name,
    result: 'FAIL',
    details: `${SCHEMA_ERROR_PREFIX}constitution ${name} ${problem} — expected a list of checker names (strings); failing closed`,
  };
}

export function unfilledPlaceholderCheckerOutput(token: string): CheckerOutput {
  return {
    checker: token,
    result: 'FAIL',
    details: `${UNFILLED_PLACEHOLDER_PREFIX}'${token}' in constitution checkers — replace it with a real checker name (${STANDARD_CHECKER_NAMES.join(', ')}, custom_*); failing closed`,
  };
}

export function isConfigCheckerOutput(output: CheckerOutput): boolean {
  return (
    output.result === 'FAIL' &&
    (isUnknownCheckerOutput(output) ||
      output.details.startsWith(SCHEMA_ERROR_PREFIX) ||
      output.details.startsWith(UNFILLED_PLACEHOLDER_PREFIX))
  );
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return `a ${typeof v}`;
}

function buildCheckers(constitution: Constitution | null): Checker[] {
  const raw: unknown = constitution?.checkers;
  const invalid: CheckerOutput[] = [];
  const declared: string[] = [];
  let hasDeclaration = false;
  if (Array.isArray(raw)) {
    hasDeclaration = raw.length > 0;
    raw.forEach((v, i) =>
      typeof v === 'string'
        ? declared.push(v)
        : invalid.push(schemaErrorCheckerOutput(`checkers[${i}]`, `entry ${i} is ${describeType(v)}`)),
    );
  } else if (raw !== undefined && raw !== null) {
    hasDeclaration = true;
    invalid.push(schemaErrorCheckerOutput('checkers', `is ${describeType(raw)}, not a list`));
  }
  const checkers = new Map<string, Checker>();
  for (const checker of BUILT_IN_CHECKERS) {
    if (!hasDeclaration && checker.optIn) continue;
    if (hasDeclaration && checker.name !== WORKER_OUTPUT_CHECKER && !declared.includes(checker.name)) continue;
    checkers.set(checker.name, checker);
  }

  for (const name of declared) {
    if (checkers.has(name)) continue;
    checkers.set(
      name,
      isTemplateToken(name)
        ? { name, run: async () => unfilledPlaceholderCheckerOutput(name) }
        : name.startsWith('custom_')
          ? { name, run: (ctx) => runCustomChecker(ctx, name, ctx.router, ctx.timeoutSeconds) }
          : { name, run: async () => unknownCheckerOutput(name) },
    );
  }
  for (const o of invalid) {
    if (!checkers.has(o.checker)) checkers.set(o.checker, { name: o.checker, run: async () => o });
  }

  return [...checkers.values()];
}

function crashedOutput(name: string, e: any): CheckerOutput {
  return {
    checker: name,
    result: 'FAIL',
    details: `checker crashed: ${(e?.message ?? String(e)).slice(0, 500)}`,
  };
}

async function touchActivity(ctx: CheckerContext): Promise<void> {
  try {
    await ctx.onActivity?.();
  } catch (e: any) {
    ctx.log?.('activity_touch_failed', `activity snapshot touch failed: ${(e?.message ?? String(e)).slice(0, 500)}`);
  }
}

export function requireRunnableChecker(
  output: CheckerOutput,
  constitution: Constitution | null,
  log?: CheckerContext['log'],
): CheckerOutput {
  if (output.result !== 'SKIP' || output.unavailable !== true) return output;
  const name = output.checker;
  if (
    !Array.isArray(constitution?.checkers) ||
    !constitution.checkers.includes(name) ||
    constitution.optionalCheckers?.includes(name)
  )
    return output;
  log?.('environment_warning', `required check ${name} could not run: ${output.details}`);
  return {
    ...output,
    result: 'FAIL',
    details: `required check could not run (no model available; add it to optionalCheckers to allow skipping): ${output.details}`,
  };
}

export async function runAllCheckers(
  ctx: CheckerContext,
  router: ModelRouter,
  constitution: Constitution | null,
  customCheckerTimeoutSeconds?: number,
  only?: readonly string[],
): Promise<CheckSummary> {
  const probe = ctx.probe ?? (await (ctx.probeWorktree ?? probeWorktree)(ctx.worktree));

  const runCtx: CheckerRunCtx = {
    ...ctx,
    probe,
    constitutionBody: constitution?.body ?? '',
    testsRequired: constitution?.requireTests === true,
    router,
    timeoutSeconds: customCheckerTimeoutSeconds,
  };

  const results: CheckerOutput[] = [];
  for (const checker of buildCheckers(constitution)) {
    if (only !== undefined && !only.includes(checker.name)) continue;
    await touchActivity(ctx);
    ctx.log?.('checker_started', `checker ${checker.name} started`);
    const startedAt = Date.now();
    const meter = startResourceMeter();
    let output: CheckerOutput;
    try {
      output = await checker.run(runCtx);
    } catch (e: unknown) {
      output = crashedOutput(checker.name, e);
    }
    output = requireRunnableChecker(output, constitution, ctx.log);
    ctx.log?.('checker_completed', `checker ${checker.name} completed (${output.result})`, {
      durationMs: Date.now() - startedAt,
      ...meter.stop(),
    });
    await touchActivity(ctx);
    results.push(output);
  }

  return summarizeCheckerOutputs(results);
}

const FINDING_EVIDENCE_MAX = 300;

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

export function renderCheckerFindings(findings: readonly RegressionFinding[]): string[] {
  if (findings.length === 0) return ['- no findings'];
  return findings.map((f) => {
    const evidence = oneLine(f.evidence);
    const shown = evidence.length > FINDING_EVIDENCE_MAX ? `${evidence.slice(0, FINDING_EVIDENCE_MAX)}…` : evidence;
    return `- input: ${oneLine(f.input)} — before: ${oneLine(f.before)} — after: ${oneLine(f.after)} — ${f.reproduced ? 'reproduced' : 'not reproduced'}${shown ? ` — evidence: ${shown}` : ''}`;
  });
}

export function summarizeCheckerOutputs(results: CheckerOutput[]): CheckSummary {
  return {
    failures: results.filter((r) => r.result === 'FAIL').length,
    passes: results.filter((r) => r.result === 'PASS').length,
    skips: results.filter((r) => r.result === 'SKIP').length,
    total: results.length,
    results,
  };
}
