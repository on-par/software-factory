// src/phases/check-affected.ts — affected-test selection for CHECK rework rounds (#3260)

import {
  type AffectedTestsResolution,
  describeAffectedResolution,
  listChangedFiles,
  resolveAffectedTestsCommand,
} from '../checkers/affected-tests.js';
import { type CheckerContext, resolveTestsCommand, summarizeCheckerOutputs, testsChecker } from '../checkers/index.js';
import { type TestsAffectedConfig } from '../config/tests-section.js';
import { loadRepoConfig } from '../config/repo.js';
import type { EventKind } from '../events/kinds.js';
import type { CheckSummary, Constitution } from '../types/index.js';

export type AffectedSelection = AffectedTestsResolution & { round: number };

/** The repo's `tests.affected` config, or null when unset or unreadable. */
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

/** Returns a per-round selector: undefined (and silent) when `tests.affected` is unset, else one logged `affected_tests` resolution. */
export function createAffectedSelector(deps: {
  worktree: string;
  diffBase: string | undefined;
  constitution: Constitution | null;
  config: TestsAffectedConfig | null | undefined;
  log: (type: EventKind, msg: string) => void;
}): (round: number) => Promise<AffectedSelection | undefined> {
  const config = deps.config === undefined ? loadAffectedConfig(deps.worktree, deps.log) : deps.config;
  return async (round) => {
    if (!config) return undefined;
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
    return { ...resolution, round };
  };
}

/** Rework instruction 3 for this round; undefined keeps the default text. */
export async function affectedVerifyInstruction(
  sel: AffectedSelection | undefined,
  ctx: CheckerContext,
): Promise<string | undefined> {
  if (!sel) return undefined;
  if (sel.kind === 'affected') {
    return `Re-run only the affected tests: \`${sel.command}\` (add any other file you change to the list). CHECK runs the full suite before SHIP.`;
  }
  const full = (await resolveTestsCommand(ctx)).argv.join(' ');
  return `Re-run the full test command \`${full}\` (affected-test selection fell back to the full suite: ${sel.reason}${sel.trigger === undefined ? '' : ` — ${sel.trigger}`}).`;
}

/** A rework round that passed on affected tests only counts after one full tests run; a FAIL there keeps the rework loop going. */
export async function fullTestsBeforeShip(
  summary: CheckSummary,
  ctx: CheckerContext,
  round: number,
  log: (type: EventKind, msg: string) => void,
): Promise<CheckSummary> {
  const testsPassed = summary.results.some((r) => r.checker === 'tests' && r.result === 'PASS');
  if (ctx.affectedTests?.kind !== 'affected' || summary.failures > 0 || !testsPassed) return summary;
  ctx.affectedTests = undefined;
  const full = await testsChecker(ctx);
  log('check', `full tests pass before SHIP (affected round ${round} passed): ${full.result}`);
  const merged = summarizeCheckerOutputs(summary.results.map((r) => (r.checker === 'tests' ? full : r)));
  return summary.warnings ? { ...merged, warnings: summary.warnings } : merged;
}
