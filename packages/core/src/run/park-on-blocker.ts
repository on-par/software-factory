// src/run/park-on-blocker.ts — runIssue's BLOCKED_BY park decision (#2317).
//
// Files the claimed prerequisite through runBlockerTrigger and parks the parent blocked (child listed),
// held (filer refused) or escalated (claim restates the parent, or a local-only run with no GitHub).

import type { Octokit } from '@octokit/rest';

import { type BlockerClaim, runBlockerTrigger } from '../blockers/index.js';
import type { ParkReason, RunOutcome } from './outcome.js';
import type { RunRequest } from './run-issue.js';

export function blockerParker(deps: {
  request: Pick<RunRequest, 'issue' | 'repo' | 'work' | 'localOnly'>;
  ports: { octokit: Octokit };
  terminalEscalated: (message: string) => Promise<RunOutcome>;
  terminalParked: (
    reason: ParkReason,
    message: string,
    checkFailure?: undefined,
    ciFailure?: undefined,
    blockers?: readonly number[],
  ) => Promise<RunOutcome>;
}) {
  const { request, ports, terminalEscalated, terminalParked } = deps;
  return async (phase: 'plan' | 'build', claim: BlockerClaim, escalate: string | undefined): Promise<RunOutcome> => {
    if (request.localOnly) return terminalEscalated(`${phase} escalated: ${escalate ?? 'unknown'}`);
    const decision = await runBlockerTrigger({
      octokit: ports.octokit,
      repo: request.repo,
      parent: { number: request.issue, title: request.work.title, body: request.work.brief },
      claim,
      phase,
    });
    if (decision.reason === 'escalate') return terminalEscalated(decision.message);
    return terminalParked(decision.reason, decision.message, undefined, undefined, decision.blockers);
  };
}
