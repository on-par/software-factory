// packages/scbench-adapter/src/leak-guard.ts — generic rendered-text leak guard for hidden evaluation.json identifiers (#1250, #1204).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadBaselineConfig, parseEvaluation } from './baseline.js';

/** Hidden values that must never appear in a rendered brief: retained
 *  evaluation.json test names and problem ids that were not deliberately
 *  surfaced by the template. */
export interface LeakGuardHiddenValues {
  testNames: string[];
  problemIds: string[];
}

/** Scan rendered brief text for any of the given hidden test names or
 *  problem ids; returns the ones actually found (substring match), or []
 *  when the text is clean. Generic over the caller's rendered text and
 *  hidden-value list so it is reusable across brief types (and any future
 *  rendered-text leak guard in this package). */
export function findLeakedValues(rendered: string, hidden: LeakGuardHiddenValues): string[] {
  return [...hidden.testNames, ...hidden.problemIds].filter((value) => rendered.includes(value));
}

function findEvaluationFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findEvaluationFiles(path));
    } else if (entry.name === 'evaluation.json') {
      found.push(path);
    }
  }
  return found;
}

/** Gather every retained hidden value: the passed/failed test names of each
 *  evaluation.json under the given roots (missing roots are skipped) plus
 *  the baseline config's problem ids. Deduped and sorted. Reusable by any
 *  rendered-text leak guard (constitution, briefs). */
export function collectRetainedHiddenValues(
  evidenceRoots: readonly string[],
  baselineConfigPath: string,
): LeakGuardHiddenValues {
  const testNames = new Set<string>();
  for (const root of evidenceRoots) {
    if (!existsSync(root)) continue;
    for (const path of findEvaluationFiles(root)) {
      const evaluation = parseEvaluation(readFileSync(path, 'utf-8'), path);
      for (const group of Object.values(evaluation.tests ?? {})) {
        for (const name of [...group.passed, ...group.failed]) testNames.add(name);
      }
    }
  }
  const { problems } = loadBaselineConfig(readFileSync(baselineConfigPath, 'utf-8'));
  return {
    testNames: [...testNames].sort(),
    problemIds: [...new Set([problems.smoke, ...problems.suite])].sort(),
  };
}
