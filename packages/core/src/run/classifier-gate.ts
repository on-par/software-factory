// packages/core/src/run/classifier-gate.ts — applies the pre-SHIP classifier gate label (ADR-0123, #1724, #1958).

import type { Octokit } from '@octokit/rest';
import { DEFAULT_T1_SAMPLE_RATE, type TrustTier } from '../config/repo.js';
import { decideT1Sample, type ReviewRouting } from '../review/routing.js';
import type { RunLogFn } from './attribution.js';
import { withoutHumanOnlyLabels } from './max-lines-override.js';

/** Adds the gate label to the issue and logs the `merge-gated` receipt. Returns a held-park reason when the
 *  label cannot be applied (the run then parks held), else undefined. */
export async function applyClassifierGateLabel(
  octokit: Octokit,
  request: { repo: string; issue: number; label: string },
  routing: ReviewRouting,
  log: RunLogFn,
): Promise<string | undefined> {
  const { label } = request;
  const [owner, repo] = request.repo.split('/');
  const labels = withoutHumanOnlyLabels([label]);
  try {
    if (labels.length > 0) await octokit.rest.issues.addLabels({ owner, repo, issue_number: request.issue, labels });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `issue held: classifier gate label '${label}' could not be applied (${routing.reason}): ${detail} — needs a human`;
  }
  const sampled = routing.sample?.held
    ? ` (sample ${routing.sample.value.toFixed(4)} < rate ${routing.sample.rate})`
    : '';
  log(
    'merge-gated',
    `${routing.reason} — applied ${label}; auto-merge held for a human${routing.error ? ` (${routing.error})` : ''}${sampled}`,
  );
  return undefined;
}

/** Applies the T1 deterministic sample to the floor routing (ADR-0144, #1958). Undefined tier = T0. */
export function sampleT1Routing(
  routing: ReviewRouting,
  request: { repo: string; issue: number; prClassifier?: { trustTier?: TrustTier; t1SampleRate?: number } },
): ReviewRouting {
  return decideT1Sample(routing, {
    trustTier: request.prClassifier?.trustTier ?? 'T0',
    rate: request.prClassifier?.t1SampleRate ?? DEFAULT_T1_SAMPLE_RATE,
    repo: request.repo,
    issue: request.issue,
  });
}
