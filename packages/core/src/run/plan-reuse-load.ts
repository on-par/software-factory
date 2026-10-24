// src/run/plan-reuse-load.ts — PLAN reuse after an environment release (#2340): load, then always clear, the record.

import { issueBodyHash, type PlanReuseStore } from './resume-context.js';
import type { RunLogFn } from './attribution.js';

/** The frozen plan to reuse when the issue body is unchanged since the environment release, else null. */
export async function loadReusablePlan(
  store: PlanReuseStore | undefined,
  request: { issue: number; specPath: string; work: { brief: string } },
  log: RunLogFn,
  planLog: RunLogFn,
): Promise<Awaited<ReturnType<PlanReuseStore['load']>>> {
  if (!store) return null;
  let hit: Awaited<ReturnType<PlanReuseStore['load']>> = null;
  try {
    hit = await store.load(issueBodyHash(request.work.brief));
  } catch (err) {
    log('environment_warning', `could not read the plan-reuse record: ${errorMessage(err)} — planning`);
  }
  try {
    await store.clear();
  } catch (err) {
    log('environment_warning', `could not clear the plan-reuse record: ${errorMessage(err)}`);
  }
  if (hit) {
    planLog(
      'plan_reused',
      `reusing frozen plan ${request.specPath} for #${request.issue} — body unchanged since the environment release, no PLAN model call`,
    );
  }
  return hit;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
