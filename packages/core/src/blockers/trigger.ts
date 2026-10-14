// src/blockers/trigger.ts — turns a validated BLOCKED_BY claim into a park decision (#2317).
//
// Files exactly one blocker child through the deterministic filer (#2316) and maps the result
// to the park reason runIssue should use: blocked (child tracked), held (filer refused) or
// escalate (claim restates the parent's own scope, nothing filed).

import type { Octokit } from '@octokit/rest';

import { DEFAULT_FILING_POLICY, type FilingPolicy } from '../filing/policy.js';
import { claimRestatesParent } from './claim.js';
import { type BlockerClaim, BlockerFilingError, fileBlocker } from './file-blocker.js';

export type BlockerTriggerOutcome =
  | { reason: 'blocked'; message: string; blockers: number[] }
  | { reason: 'held'; message: string; blockers: number[] }
  | { reason: 'escalate'; message: string };

export async function runBlockerTrigger(deps: {
  octokit: Octokit;
  repo: string;
  parent: { number: number; title: string; body: string };
  claim: BlockerClaim;
  phase: 'plan' | 'build';
  policy?: Pick<FilingPolicy, 'maxPerDay'>;
  file?: typeof fileBlocker;
  now?: () => Date;
}): Promise<BlockerTriggerOutcome> {
  const { claim, parent, phase } = deps;
  const restates = claimRestatesParent(claim, parent);
  if (restates) {
    return { reason: 'escalate', message: `${phase} escalated: invalid BLOCKED_BY claim: ${restates}` };
  }
  try {
    const result = await (deps.file ?? fileBlocker)({
      octokit: deps.octokit,
      repo: deps.repo,
      parent: parent.number,
      claim,
      policy: deps.policy ?? { maxPerDay: DEFAULT_FILING_POLICY.maxPerDay },
      ...(deps.now ? { now: deps.now } : {}),
    });
    const blockers = [result.number];
    if (result.outcome === 'filed') {
      return {
        reason: 'blocked',
        message: `blocked by #${result.number} (${claim.title}) — filed from ${phase.toUpperCase()}`,
        blockers,
      };
    }
    if (result.outcome === 'existing') {
      return { reason: 'blocked', message: `blocked by existing blocker #${result.number} (${claim.title})`, blockers };
    }
    return {
      reason: 'blocked',
      message: `blocked by open sub-issue #${result.number} (${result.title}), which already covers the claimed prerequisite`,
      blockers,
    };
  } catch (err) {
    if (err instanceof BlockerFilingError) {
      return {
        reason: 'held',
        message: `blocker filing refused (${err.reason}): ${err.message}`,
        blockers: err.childNumber !== undefined ? [err.childNumber] : [],
      };
    }
    return {
      reason: 'held',
      message: `blocker filing refused (error): ${err instanceof Error ? err.message : String(err)}`,
      blockers: [],
    };
  }
}
