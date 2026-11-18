import { parseDesignArtifact } from '../design/index.js';
import type { PlanResult } from '../phases/plan.js';
import { readSpec } from '../spec/index.js';
import { UNTRUSTED_CHECKER_OUTPUT_NOTICE, wrapUntrustedCheckerOutput } from '../utils/untrusted-input.js';
import type { RunLogFn } from './attribution.js';
import type { RemainingWorkHandoff } from './handoff.js';

export function continuationDone(h: RemainingWorkHandoff): boolean {
  return h.criteria.length > 0 && h.criteria.every((c) => c.status === 'done');
}

export function continuationNote(h: RemainingWorkHandoff): string {
  const done = h.criteria.filter((c) => c.status === 'done').map((c) => `- ${c.criterion}`);
  const left = h.criteria.filter((c) => c.status !== 'done').map((c) => `- ${c.criterion} (${c.status})`);
  return [
    '## Continuing a stopped run',
    `This run continues from ${h.wipBranch ?? 'the WIP branch'} @ ${h.headSha ?? 'unknown'}, which stopped during ${h.phase.toUpperCase()}. Its commits are already on this branch: keep them and do not redo finished work.`,
    ...(done.length > 0 ? ['', 'Already done, do not rebuild:', ...done] : []),
    ...(left.length > 0 ? ['', 'Remaining acceptance criteria:', ...left] : []),
    ...(h.lastFailure
      ? ['', UNTRUSTED_CHECKER_OUTPUT_NOTICE, 'Last failing check:', wrapUntrustedCheckerOutput(h.lastFailure)]
      : []),
  ].join('\n');
}

export async function loadContinuationPlan(
  h: RemainingWorkHandoff,
  specPath: string,
  log: RunLogFn,
): Promise<PlanResult | null> {
  if (h.specPath === null) return null;
  let spec;
  try {
    spec = await readSpec(specPath);
  } catch (err) {
    log(
      'environment_warning',
      `could not read the frozen spec ${specPath} (${err instanceof Error ? err.message : String(err)}) — planning`,
    );
    return null;
  }
  if (spec.route === null) {
    log('environment_warning', `frozen spec ${specPath} has no build route — planning`);
    return null;
  }
  const { artifact } = parseDesignArtifact(spec.data);
  log(
    'plan_reused',
    `continuing from ${h.wipBranch ?? 'the WIP branch'} — reusing frozen spec ${specPath}, PLAN skipped`,
  );
  return { ok: true, route: spec.route, specPath, model: 'plan-continued', designArtifact: artifact };
}
