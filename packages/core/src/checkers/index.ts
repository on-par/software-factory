// src/checkers/index.ts — Checker framework: built-in + custom checkers

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput, CheckSummary, Constitution, RegressionFinding } from '../types/index.js';
import { type CommandResult, type RunCommandOptions } from '../utils/command-runner.js';
import { runVerificationCommand as runCommand } from './run-command.js';
import { extractJsonObjects } from '../utils/json.js';
import {
  DESIGN_SMELLS_CHECKER,
  designSmellsChecker,
  workerOutputChecker,
  WORKER_OUTPUT_CHECKER,
} from './design-smells.js';
import {
  countPlaceholderLinks,
  detectPythonTestSurface,
  fileExists,
  findHtmlFiles,
  probeWorktree,
  type WorktreeProbe,
} from './probe.js';

export type { PackageJsonProbe, PythonTestSurface, PythonTestSurfaceSource, WorktreeProbe } from './probe.js';
export { countPlaceholderLinks, detectPythonTestSurface, fileExists, findHtmlFiles, probeWorktree } from './probe.js';

interface PackageJson {
  scripts?: Record<string, string>;
  [k: string]: unknown;
}

export interface CheckerContext {
  worktree: string;
  specPath: string;
  /** Run-start HEAD SHA captured by buildPhase before the worker ran — the diff base
   *  for checkouts with no origin/main or origin/master (#1162, #1211). */
  diffBase?: string;
  /** Set by runAllCheckers from the resolved constitution — the single source of the standards text */
  constitutionBody?: string;
  packageJson?: PackageJson | null;
  /** Set by runAllCheckers from constitution.requireTests — missing test command becomes FAIL instead of SKIP */
  testsRequired?: boolean;
  /** Once-per-round worktree facts (package.json, HTML files, Playwright configs) — set by checkPhase
   *  each round; runAllCheckers probes and attaches these when it is absent. */
  probe?: WorktreeProbe;
  /** Injection seam for tests: overrides the default probeWorktree implementation. */
  probeWorktree?: (worktree: string) => Promise<WorktreeProbe>;
  /** Injection seam for tests: overrides the default runCommand implementation. */
  runCommand?: (argv: readonly string[], options?: RunCommandOptions) => Promise<CommandResult>;
  /** Lane environment (FACTORY_HEADLESS, PLAYWRIGHT_HEADLESS, and PORT/FACTORY_APP_PORT/FACTORY_BASE_URL when a port is leased) merged into every checker command — set by checkPhase */
  env?: Record<string, string>;
  /** When set, every checker command is spawned detached (its own process
   *  group) and its pid reported here so the lane can track and later kill
   *  the whole group — set by checkPhase. */
  onPgid?: (pgid: number) => void;
  /** Injection seam for phase/checker timing events (#1321) — set by checkPhase. */
  log?: (type: EventKind, msg: string, extra?: { durationMs?: number }) => void;
  /** Heartbeat hook (#1326): called around every checker so the persisted run-phase
   *  snapshot's `lastActivityAt` advances during CHECK, not just at phase transitions —
   *  set by checkPhase. A rejection is logged (`activity_touch_failed`) and swallowed:
   *  this is an observability side channel, not a checker-run invariant. */
  onActivity?: () => void | Promise<void>;
  /** Directory where a failing checker command writes its full stdout/stderr — set by
   *  checkPhase per round. The FAIL details carry only a bounded summary plus this
   *  log's path, so the rework worker and a human can read what the cap cut. */
  outputLogDir?: string;
}

export type CheckerFn = (ctx: CheckerContext) => Promise<CheckerOutput>;

/** A runnable checker in the single unified registry — one shape for every world. */
export interface Checker {
  name: string;
  run(ctx: CheckerRunCtx): Promise<CheckerOutput>;
}

/** CheckerContext bound by runAllCheckers with the router + custom-checker timeout. */
export interface CheckerRunCtx extends CheckerContext {
  router: ModelRouter;
  timeoutSeconds?: number;
}

// ---------- Built-in Checkers ----------

export const compileChecker: CheckerFn = async (ctx) => {
  try {
    const pkg = await getPackageJson(ctx);
    const hasBuild = pkg?.scripts?.build;

    if (hasBuild) {
      const r = await runCommand(['npm', 'run', 'build'], {
        cwd: ctx.worktree,
        timeoutMs: 120_000,
        env: ctx.env,
        onPgid: ctx.onPgid,
      });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'npm run build: OK' };
      return {
        checker: 'compile',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'compile', 'npm run build', r, describeCommandFailureTail(r, 500)),
      };
    }

    if (await fileExists(join(ctx.worktree, 'Makefile'))) {
      const r = await runCommand(['make'], { cwd: ctx.worktree, timeoutMs: 120_000, env: ctx.env, onPgid: ctx.onPgid });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'make: OK' };
      return {
        checker: 'compile',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'compile', 'make', r, describeCommandFailureTail(r, 500)),
      };
    }

    if (await fileExists(join(ctx.worktree, 'Cargo.toml'))) {
      const r = await runCommand(['cargo', 'build'], {
        cwd: ctx.worktree,
        timeoutMs: 120_000,
        env: ctx.env,
        onPgid: ctx.onPgid,
      });
      if (r.ok) return { checker: 'compile', result: 'PASS', details: 'cargo build: OK' };
      return {
        checker: 'compile',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'compile', 'cargo build', r, describeCommandFailureTail(r, 500)),
      };
    }

    return { checker: 'compile', result: 'PASS', details: 'no build system detected — skipped' };
  } catch (e: any) {
    return {
      checker: 'compile',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
    };
  }
};

const COMMANDER_REQUIRED_OPTION_PATTERN = /^error: required option '.+' not specified$/gm;

/** Removes terminal escape sequences: SGR/CSI (`ESC[1;31m`, `ESC[2K`) and charset selects (`ESC(B`). */
function stripAnsi(text: string): string {
  return text
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-9;?]*[A-Za-z]|^[()][A-Za-z0-9]/, '')))
    .join('');
}

function stripIncidentalCommanderNoise(text: string): string {
  return text
    .replace(COMMANDER_REQUIRED_OPTION_PATTERN, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Where a failing test announces itself, per runner, and how many lines of its message to keep.
 *  Checked in order, so a vitest FAIL line wins over a vitest suite summary. */
const FAILED_TEST_MARKERS: readonly { pattern: RegExp; lines: number }[] = [
  // vitest: " FAIL  file > suite > test"
  { pattern: /\bFAIL\s+.+\s+>/, lines: 12 },
  // vitest suite summary: " > file (6 tests | 1 failed) 15ms"
  { pattern: /^\s*\S+\s+.+\(\d+ tests?\s+\|\s+\d+ failed\)/, lines: 8 },
  // .NET Microsoft.Testing.Platform: "failed Namespace.Class.Test (46ms)"
  { pattern: /^\s*failed\s+\S+\s+\((?:\d+(?:\.\d+)?\s*(?:ms|s|m)\s*)+\)\s*$/, lines: 12 },
  // .NET VSTest: "  Failed Namespace.Class.Test [46 ms]"
  { pattern: /^\s*Failed\s+\S+\s+\[[^\]]+\]\s*$/, lines: 12 },
  // go test: "--- FAIL: TestName (0.00s)"
  { pattern: /^\s*--- FAIL:\s+\S+/, lines: 12 },
  // pytest short summary: "FAILED tests/test_x.py::test_y - AssertionError"
  { pattern: /^FAILED\s+\S+::\S+/, lines: 8 },
];

/** npm echoes the script it runs at column 0 (`> node -e "..."`); that text is the command, not its output. */
const NPM_SCRIPT_ECHO = /^> /;

function extractFailedTestEvidence(output: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  for (const { pattern, lines: keep } of FAILED_TEST_MARKERS) {
    const start = lines.findIndex((line) => !NPM_SCRIPT_ECHO.test(line) && pattern.test(line));
    if (start >= 0) {
      return lines
        .slice(start, start + keep)
        .join('\n')
        .trim();
    }
  }
  return null;
}

/** Bounded tail of command output. Runners print banners first and failures and summaries
 *  last, so a head slice keeps the banner and drops the error. */
function outputTail(text: string, maxChars: number): string {
  const clean = stripAnsi(text).trim();
  if (clean.length <= maxChars) return clean;
  const tail = clean.slice(-maxChars);
  // Drop the partial first line, unless that would throw away most of the tail.
  const lineStart = tail.indexOf('\n');
  return `…${lineStart >= 0 && lineStart < maxChars / 2 ? tail.slice(lineStart + 1) : tail}`;
}

function describeCommandFailureTail(r: CommandResult, maxChars: number): string {
  const output = r.stderr.trim() !== '' ? r.stderr : r.stdout;
  return outputTail(output, maxChars) || (r.timedOut ? 'timed out' : `exit code ${r.exitCode}`);
}

/** Failed-test evidence when a known runner format is found on stdout or stderr, else the output's tail. */
function describeTestFailure(r: CommandResult, maxChars: number): string {
  const stdoutEvidence = extractFailedTestEvidence(r.stdout);
  if (stdoutEvidence) {
    const stderr = stripIncidentalCommanderNoise(stripAnsi(r.stderr));
    return (stderr ? `${stdoutEvidence}\nstderr:\n${stderr}` : stdoutEvidence).slice(0, maxChars);
  }

  const stderrEvidence = extractFailedTestEvidence(r.stderr);
  if (stderrEvidence) return stderrEvidence.slice(0, maxChars);

  return describeCommandFailureTail(r, maxChars);
}

/** Writes a failed command's full stdout/stderr under ctx.outputLogDir. Returns the path,
 *  or null when no log dir is set or the write fails — the log is a diagnostic side
 *  channel and must never change a checker's verdict. */
async function writeCommandLog(ctx: CheckerContext, name: string, r: CommandResult): Promise<string | null> {
  if (!ctx.outputLogDir) return null;
  const path = join(ctx.outputLogDir, `${name.replace(/[^A-Za-z0-9.]+/g, '-')}.log`);
  try {
    await mkdir(ctx.outputLogDir, { recursive: true });
    await writeFile(
      path,
      [
        `$ ${r.command.join(' ')}`,
        `exit code: ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`,
        '',
        '--- stdout ---',
        stripAnsi(r.stdout),
        '--- stderr ---',
        stripAnsi(r.stderr),
        '',
      ].join('\n'),
    );
    return path;
  } catch {
    return null;
  }
}

/** FAIL details for a checker command: `<label> failed: <summary>`, plus the full-output
 *  log path when one was written. The path sits after the bounded summary so the cap never cuts it. */
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

export type TestsRunner = 'verify' | 'npm' | 'pytest' | 'none';

/** The command the `tests` checker runs for a worktree; argv is [] when runner is 'none'. */
export interface TestsCommand {
  runner: TestsRunner;
  argv: string[];
  /** Label used in FAIL details and the output-log name (`verify.sh`, `npm test`, `pytest`, `''` for none). */
  label: string;
}

export async function resolveTestsCommand(ctx: CheckerContext): Promise<TestsCommand> {
  if (await fileExists(join(ctx.worktree, 'scripts/verify.sh')))
    return { runner: 'verify', argv: ['bash', 'scripts/verify.sh', '--no-e2e'], label: 'verify.sh' };
  const pkg = await getPackageJson(ctx);
  if (pkg?.scripts?.test) return { runner: 'npm', argv: ['npm', 'test'], label: 'npm test' };
  const pythonSurface = ctx.probe?.pythonTestSurface ?? (await detectPythonTestSurface(ctx.worktree));
  if (pythonSurface.present)
    return {
      runner: 'pytest',
      argv: pythonSurface.sources.includes('.factory/tests/')
        ? ['python3', '-m', 'pytest', '.factory/tests']
        : ['python3', '-m', 'pytest'],
      label: 'pytest',
    };
  return { runner: 'none', argv: [], label: '' };
}

const TESTS_PASS_DETAILS = {
  verify: 'scripts/verify.sh: OK',
  npm: 'npm test: OK',
  pytest: 'python3 -m pytest: OK',
} as const;

export const testsChecker: CheckerFn = async (ctx) => {
  try {
    const run = ctx.runCommand ?? runCommand;
    const cmd = await resolveTestsCommand(ctx);
    if (cmd.runner !== 'none') {
      const r = await run(cmd.argv, {
        cwd: ctx.worktree,
        timeoutMs: 300_000,
        env: ctx.env,
        onPgid: ctx.onPgid,
      });
      if (r.ok) return { checker: 'tests', result: 'PASS', details: TESTS_PASS_DETAILS[cmd.runner] };
      // For pytest, fail closed: a surface that cannot run (pytest missing, import error) is FAIL, never SKIP
      return {
        checker: 'tests',
        result: 'FAIL',
        details: await commandFailureDetails(ctx, 'tests', cmd.label, r, describeTestFailure(r, 500)),
      };
    }

    if (ctx.testsRequired) {
      return {
        checker: 'tests',
        result: 'FAIL',
        details:
          'no verification command was run — constitution requires tests (requireTests: true) but the worktree has no pytest, scripts/verify.sh, or npm-test surface',
      };
    }
    return {
      checker: 'tests',
      result: 'SKIP',
      details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
    };
  } catch (e: any) {
    return {
      checker: 'tests',
      result: 'FAIL',
      details: `unexpected checker error: ${(e?.stderr || e?.message || String(e)).slice(0, 500)}`,
    };
  }
};

export const lintChecker: CheckerFn = async (ctx) => {
  const details: string[] = [];
  let result: 'PASS' | 'FAIL' = 'PASS';

  const pkg = await getPackageJson(ctx);
  const scripts = pkg?.scripts ?? {};

  if (scripts.lint) {
    const r = await runCommand(['npm', 'run', 'lint'], {
      cwd: ctx.worktree,
      timeoutMs: 120_000,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    if (r.ok) {
      details.push('lint: OK');
    } else {
      result = 'FAIL';
      details.push(await commandFailureDetails(ctx, 'lint', 'lint', r, describeCommandFailureTail(r, 300)));
    }
  }

  // TypeScript type check
  if (await fileExists(join(ctx.worktree, 'tsconfig.json'))) {
    const r = await runCommand(['npx', 'tsc', '--noEmit'], {
      cwd: ctx.worktree,
      timeoutMs: 120_000,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    if (r.ok) {
      details.push('tsc: OK');
    } else {
      result = 'FAIL';
      details.push(await commandFailureDetails(ctx, 'lint', 'tsc', r, describeCommandFailureTail(r, 300)));
    }
  }

  if (details.length === 0) {
    details.push('no linting configured — skipped');
  }

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

    // Images without alt
    const imgNoAlt = (html.match(/<img[^>]*>/g) ?? []).filter((t) => !t.includes('alt=')).length;
    if (imgNoAlt > 0) {
      issues += imgNoAlt;
      details.push(`${rel}: ${imgNoAlt} images without alt`);
    }

    // Placeholder links
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

// ---------- Custom Checker (agent-based) ----------

/** Trust boundary: LLM checker output is unvalidated JSON — accept only an exact-shape verdict. */
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
      timeoutSeconds: timeoutSeconds ?? 1800,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    // Extract the verdict: first balanced JSON object that carries a "checker" key
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

// ---------- Runner: run all checkers for a product ----------

/** The unified registry: every checker — built-in, agent-backed, custom, unknown — runs through the same fail-closed path. */
const BUILT_IN_CHECKERS: readonly Checker[] = [
  { name: WORKER_OUTPUT_CHECKER, run: (ctx) => workerOutputChecker(ctx) },
  { name: 'compile', run: (ctx) => compileChecker(ctx) },
  { name: 'tests', run: (ctx) => testsChecker(ctx) },
  { name: 'lint', run: (ctx) => lintChecker(ctx) },
  { name: 'links', run: (ctx) => linksChecker(ctx) },
  { name: 'accessibility', run: (ctx) => accessibilityChecker(ctx) },
  { name: DESIGN_SMELLS_CHECKER, run: (ctx) => designSmellsChecker(ctx, ctx.router, ctx.timeoutSeconds) },
];

const STANDARD_CHECKER_NAMES = BUILT_IN_CHECKERS.map((c) => c.name);

/** Fail closed: a declared standard we can't run must not vanish from the summary. */
function unknownCheckerOutput(name: string): CheckerOutput {
  return {
    checker: name,
    result: 'FAIL',
    details: `unknown checker '${name}' — not a built-in (${STANDARD_CHECKER_NAMES.join(', ')}) and not a custom_* agent checker; failing closed so the declared standard is not silently skipped`,
  };
}

/** Built-ins first (current order), then constitution checkers not already registered, in constitution order. */
function buildCheckers(constitution: Constitution | null): Checker[] {
  const checkers = new Map<string, Checker>();
  for (const checker of BUILT_IN_CHECKERS) checkers.set(checker.name, checker);

  for (const name of constitution?.checkers ?? []) {
    if (checkers.has(name)) continue;
    checkers.set(
      name,
      name.startsWith('custom_')
        ? { name, run: (ctx) => runCustomChecker(ctx, name, ctx.router, ctx.timeoutSeconds) }
        : { name, run: async () => unknownCheckerOutput(name) },
    );
  }

  return [...checkers.values()];
}

/** Invokes `ctx.onActivity`, logging and swallowing any rejection (#1326) — an
 *  observability side channel must never fail a checker run. */
async function touchActivity(ctx: CheckerContext): Promise<void> {
  try {
    await ctx.onActivity?.();
  } catch (e: any) {
    ctx.log?.('activity_touch_failed', `activity snapshot touch failed: ${(e?.message ?? String(e)).slice(0, 500)}`);
  }
}

/** `only` restricts the run to these checker names (the baseline re-run, #1925). Undefined runs every checker. */
export async function runAllCheckers(
  ctx: CheckerContext,
  router: ModelRouter,
  constitution: Constitution | null,
  customCheckerTimeoutSeconds?: number,
  only?: readonly string[],
): Promise<CheckSummary> {
  const probe = ctx.probe ?? (await (ctx.probeWorktree ?? probeWorktree)(ctx.worktree));

  // the constitution is the single source of truth for the standards body —
  // custom checkers must be graded against the same text that declared them
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
    let output: CheckerOutput;
    try {
      output = await checker.run(runCtx);
    } catch (e: any) {
      // Fail closed: a checker that crashes must not vanish from the summary
      output = {
        checker: checker.name,
        result: 'FAIL',
        details: `checker crashed: ${(e?.message ?? String(e)).slice(0, 500)}`,
      };
    }
    ctx.log?.('checker_completed', `checker ${checker.name} completed (${output.result})`, {
      durationMs: Date.now() - startedAt,
    });
    await touchActivity(ctx);
    results.push(output);
  }

  return summarizeCheckerOutputs(results);
}

/** Folds checker outputs into the CheckSummary shape every review/report consumes. */
const FINDING_EVIDENCE_MAX = 300;

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** One markdown bullet per regression finding — the single formatter the check summary and evidence pack share. */
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

// ---------- Helpers ----------

async function loadPackageJson(worktree: string): Promise<PackageJson | null> {
  let raw: string;
  try {
    raw = await readFile(join(worktree, 'package.json'), 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null; // no package.json is a legitimate skip, not an error
    throw e;
  }
  return JSON.parse(raw) as PackageJson;
}

async function getPackageJson(ctx: CheckerContext): Promise<PackageJson | null> {
  if (ctx.packageJson !== undefined) return ctx.packageJson;
  const p = ctx.probe?.packageJson;
  if (p) {
    switch (p.status) {
      case 'loaded':
        return p.value;
      case 'absent':
        return null;
      case 'unreadable':
        throw p.error;
    }
  }
  return loadPackageJson(ctx.worktree);
}
