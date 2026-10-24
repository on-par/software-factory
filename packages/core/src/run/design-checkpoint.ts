// src/run/design-checkpoint.ts — opt-in post-PLAN design checkpoint (#3621)

import type { Octokit } from '@octokit/rest';

import type { RunLogFn } from './attribution.js';
import { readWorktreeHead } from './ci-suppression-guard.js';
import type { RunPorts, RunRequest } from './run-issue.js';
import { issueBodyHash, type PlanReuseRecord } from './resume-context.js';

/** Issue label that parks a run for a human design review right after a successful PLAN. */
export const NEEDS_DESIGN_LABEL = 'factory:needs-design';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether the issue carries the needs-design label (trimmed, case-insensitive). A read failure reports `error`. */
export async function readNeedsDesignLabel(
  octokit: Octokit,
  repo: string,
  issue: number,
): Promise<{ present: boolean; error?: string }> {
  try {
    const [owner, name] = repo.split('/');
    const { data } = await octokit.rest.issues.get({ owner, repo: name, issue_number: issue });
    const present = data.labels.some(
      (label) => (typeof label === 'string' ? label : (label.name ?? '')).trim().toLowerCase() === NEEDS_DESIGN_LABEL,
    );
    return { present };
  } catch (err) {
    return { present: false, error: errorMessage(err) };
  }
}

/** The park message: why the run paused, where the plan is, and how to approve. */
export function designCheckpointMessage(input: { issue: number; specPath: string; branch: string }): string {
  return (
    `design checkpoint: issue #${input.issue} is labeled ${NEEDS_DESIGN_LABEL}, so the run paused after PLAN for a human design review. ` +
    `Plan artifact: ${input.specPath} (branch ${input.branch}). ` +
    `To approve, review the plan, remove the ${NEEDS_DESIGN_LABEL} label, then run \`factory unpark ${input.issue}\`. ` +
    'BUILD resumes on the same plan and branch. Editing the issue body re-plans.'
  );
}

/**
 * The receipt to park with when a github-issue run is labeled needs-design (after recording the plan for reuse),
 * else undefined. Local-brief and localOnly runs skip the gate; a label-read failure fails open.
 */
export async function designCheckpointPark(
  request: Pick<RunRequest, 'repo' | 'issue' | 'work' | 'specPath' | 'branch' | 'localOnly'>,
  ports: Pick<RunPorts, 'octokit' | 'workspace' | 'planReuse'>,
  route: PlanReuseRecord['route'],
  log: RunLogFn,
): Promise<string | undefined> {
  if (request.work.kind !== 'github-issue' || request.localOnly) return undefined;
  const label = await readNeedsDesignLabel(ports.octokit, request.repo, request.issue);
  if (label.error) {
    log('environment_warning', `could not read labels for the design checkpoint: ${label.error} — continuing to BUILD`);
  }
  if (!label.present) return undefined;
  if (ports.planReuse) {
    try {
      const baseSha = await readWorktreeHead(ports.workspace.path);
      await ports.planReuse.record({
        bodyHash: issueBodyHash(request.work.brief),
        baseSha,
        route,
        releasedAt: new Date().toISOString(),
      });
    } catch (err) {
      log('environment_warning', `could not record the plan-reuse record: ${errorMessage(err)}`);
    }
  }
  return designCheckpointMessage({ issue: request.issue, specPath: request.specPath, branch: request.branch });
}
