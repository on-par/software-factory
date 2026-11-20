import {
  type AffectedTestsResolution,
  describeAffectedResolution,
  listChangedFiles,
  resolveAffectedTestsCommand,
} from '../checkers/affected-tests.js';
import {
  type CheckerContext,
  compileChecker,
  resolveCompileCommand,
  resolveLintCommands,
  resolveTestsCommand,
  summarizeCheckerOutputs,
  testsChecker,
} from '../checkers/index.js';
import { type TestsAffectedConfig } from '../config/tests-section.js';
import { loadRepoConfig } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import type { CheckSummary, Constitution } from '../types/index.js';

export type AffectedSelection = NonNullable<CheckerContext['affectedTests']>;
const FULL_GATE_CI_REFUSED =
  'fullGate ci refused: no required checks on the base branch; running the full gate in CHECK';

export function loadAffectedConfig(
  worktree: string,
  log?: (type: EventKind, msg: string) => void,
): TestsAffectedConfig | null {
  try {
    return loadRepoConfig(worktree)?.tests?.affected ?? null;
  } catch (err) {
    log?.(
      'affected_tests',
      `tests.affected config unreadable, running the full suite: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export function createAffectedSelector(deps: {
  worktree: string;
  diffBase?: string;
  constitution: Constitution | null;
  config: TestsAffectedConfig | null | undefined;
  log: (type: EventKind, msg: string) => void;
  requiredChecks: () => Promise<boolean>;
}): (round: number) => Promise<AffectedSelection | undefined> {
  const config = deps.config === undefined ? loadAffectedConfig(deps.worktree, deps.log) : deps.config;
  let loggedFull = false;
  let ci: Promise<boolean> | undefined;
  const orRefuse = (ok: boolean): boolean => {
    if (!ok) deps.log('affected_tests', FULL_GATE_CI_REFUSED);
    return ok;
  };
  const ciMode = (): Promise<boolean> =>
    (ci ??= config?.fullGate === 'ci' ? attempt(deps.requiredChecks, false).then(orRefuse) : Promise.resolve(false));
  return async (round) => {
    if (!config || (round === 0 && !(await ciMode()))) return undefined;
    if (config.buildVerify === 'full') {
      if (!loggedFull) deps.log('affected_tests', 'buildVerify full: running the full gate every round');
      loggedFull = true;
      return undefined;
    }
    const changed = deps.diffBase === undefined ? null : await listChangedFiles(deps.worktree, deps.diffBase);
    const resolution: AffectedTestsResolution =
      changed === null
        ? { kind: 'full', reason: 'no-diff-base', fileCount: 0 }
        : resolveAffectedTestsCommand({
            repo: { tests: { affected: config } },
            constitution: deps.constitution,
            changedFiles: changed,
          });
    deps.log('affected_tests', describeAffectedResolution(resolution, round));
    return { ...resolution, round, ...((await ciMode()) ? { fullGate: 'ci' as const } : {}) };
  };
}

export async function affectedVerifyInstruction(
  sel: AffectedSelection | undefined,
  ctx: CheckerContext,
): Promise<string | undefined> {
  if (!sel) return undefined;
  if (sel.kind === 'affected') {
    const typecheck = sel.typecheck?.command ?? (await resolveCompileLabel(ctx));
    return `Re-run only the focused commands: typecheck \`${typecheck}\`, tests \`${sel.command}\` (add any other file you change). Do not also run the full suite; ${sel.fullGate === 'ci' ? "the PR's required checks run the full gate" : 'CHECK runs one full gate before SHIP'}.`;
  }
  const full = (await resolveTestsCommand(ctx)).argv.join(' ');
  return `Re-run the full test command \`${full}\` (affected-test selection fell back to the full suite: ${sel.reason}${sel.trigger === undefined ? '' : ` — ${sel.trigger}`}).`;
}

async function resolveCompileLabel(ctx: CheckerContext): Promise<string> {
  return attempt(async () => (await resolveCompileCommand(ctx))?.argv.join(' ') ?? 'unknown', 'unknown');
}

export function describeVerifyScope(
  sel: AffectedSelection | undefined,
  compileArgv: readonly string[],
  testsArgv: readonly string[],
  lintArgvs: readonly (readonly string[])[],
  round: number,
): string {
  const head = `verify scope (round ${round}):`;
  const lint = lintArgvs.map((a) => `\`${a.join(' ')}\``).join(', ');
  if (sel?.kind === 'affected') {
    const typecheck = sel.typecheck?.command ?? compileArgv.join(' ');
    const lintPart = lint === '' ? '' : `, lint ${lint} (changed files)`;
    return `${head} focused — typecheck \`${typecheck}\`${lintPart}, tests \`${sel.command}\`; ${sel.fullGate === 'ci' ? 'full gate: ci (required checks)' : 'full gate pending before SHIP'}`;
  }
  const lintPart = lint === '' ? '' : `, lint ${lint}`;
  return `${head} full — compile \`${compileArgv.join(' ')}\`${lintPart}, tests \`${testsArgv.join(' ')}\``;
}

async function attempt<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function logVerifyScope(
  sel: AffectedSelection | undefined,
  ctx: CheckerContext,
  round: number,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  const unknown = ['unknown'];
  const compile = await attempt(async () => (await resolveCompileCommand(ctx))?.argv ?? unknown, unknown);
  const tests = await attempt(async () => (await resolveTestsCommand(ctx)).argv, unknown);
  const lint = await attempt(async () => (await resolveLintCommands(ctx)).map((c) => c.argv), [unknown]);
  log('verify_scope', describeVerifyScope(sel, compile, tests, lint, round));
}

export async function fullGateBeforeShip(
  summary: CheckSummary,
  ctx: CheckerContext,
  round: number,
  log: (type: EventKind, msg: string) => void,
): Promise<CheckSummary> {
  const testsPassed = summary.results.some((r) => r.checker === 'tests' && r.result === 'PASS');
  const sel = ctx.affectedTests;
  if (sel?.kind !== 'affected' || sel.fullGate === 'ci' || summary.failures > 0 || !testsPassed) return summary;
  ctx.affectedTests = undefined;
  const compile = sel.typecheck ? await compileChecker(ctx) : undefined;
  const full = await testsChecker(ctx);
  const compileResult = compile ?? summary.results.find((r) => r.checker === 'compile');
  const compileLabel = compileResult ? `${await resolveCompileLabel(ctx)} ${compileResult.result}, ` : '';
  const testsLabel = (await resolveTestsCommand(ctx)).argv.join(' ');
  log('verify_scope', `full gate before SHIP (round ${round}): ${compileLabel}${testsLabel} ${full.result}`);
  log('check', `full tests pass before SHIP (affected round ${round} passed): ${full.result}`);
  const merged = summarizeCheckerOutputs(
    summary.results.map((r) => {
      if (r.checker === 'tests') return full;
      return compile && r.checker === 'compile' ? compile : r;
    }),
  );
  return summary.warnings ? { ...merged, warnings: summary.warnings } : merged;
}
