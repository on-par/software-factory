// #3126 — task → pipeline phase attribution for cost rows (split out of kpis/index.ts).
import type { CostEntry } from '../types/index.js';

/** Maps a CostEntry's `task` to the pipeline phase it billed against (#614). */
const TASK_PHASE: Record<string, string> = {
  plan: 'plan',
  triage: 'plan',
  build_codex: 'build',
  build_claude: 'build',
  check_compile: 'check',
  check_tests: 'check',
  check_lint: 'check',
  check_accessibility: 'check',
  check_links: 'check',
  check_custom: 'check',
  check_design: 'check',
  dispute_resolution: 'check',
  review_pr: 'ship',
  security_review: 'ship',
  classify_pr: 'ship',
  build_opencode: 'build',
  build_command: 'build',
  readiness_enrich: 'plan',
  decompose: 'plan',
  steward: 'ship',
};

/** Maps a task name to its pipeline phase, or null if unmapped (#3126). */
export function phaseOfTask(task: string): string | null {
  return Object.hasOwn(TASK_PHASE, task) ? (TASK_PHASE[task] ?? null) : null;
}

/** Attributes one CostEntry to a phase, or null if the task isn't mapped.
 *  CHECK's rework-repair calls reuse the `build_claude` task (they run the
 *  same worker harness) but are tagged `retryCause: 'checker'`, so that
 *  signal — not the task name — decides they belong to `check` (#614). */
export function phaseOfCostEntry(entry: CostEntry): string | null {
  if (entry.retryCause === 'checker') return 'check';
  return phaseOfTask(entry.task);
}
