// packages/cli/src/cli/queue-preflight-prerequisite-stack.ts — cross-issue stacks (#3916): stack a queued issue on its
// open prerequisite's factory PR, and keep a stacked PR current (restack / hold) without ever adopting it for landing.

import {
  choosePrerequisiteStack,
  parsePrerequisiteStackMarker,
  type PrerequisiteStackTarget,
  type QueuePreflightDecision,
} from '@on-par/factory-core/internal';
import type { OpenPullRequestEvidence, QueuePreflightOps } from './queue-preflight.js';

type StackDeps = Pick<
  QueuePreflightOps,
  | 'findOpenPR'
  | 'getPullRefs'
  | 'getPullState'
  | 'branchContains'
  | 'expectedHeadRepoFullName'
  | 'stackOnOpenPrerequisite'
  | 'onDeferred'
>;

/** The prerequisite's open PR as a stack target, or undefined unless it is a same-repo `factory/<n>-` branch. */
async function openFactoryPr(prerequisite: number, deps: StackDeps): Promise<PrerequisiteStackTarget | undefined> {
  const pr = await deps.findOpenPR(prerequisite);
  if (!pr || pr.headRepoFullName !== deps.expectedHeadRepoFullName) return undefined;
  if (!pr.branch.startsWith(`factory/${prerequisite}-`)) return undefined;
  return { issue: prerequisite, prNumber: pr.number, branch: pr.branch, headSha: pr.headSha };
}

/** Decides a queued issue whose declared prerequisites are still open: continue its stacked PR, or stack on the tip.
 *  Undefined keeps today's defer (switch off, a prerequisite without a factory PR, unrelated prerequisites, a lookup error). */
export async function preflightOpenPrerequisites(
  issue: number,
  open: readonly number[],
  deps: StackDeps,
): Promise<QueuePreflightDecision | undefined> {
  if (!deps.stackOnOpenPrerequisite) return undefined;
  try {
    const own = await deps.findOpenPR(issue);
    if (own) {
      if (own.headRepoFullName !== deps.expectedHeadRepoFullName) return undefined;
      return await stackedPullDecision(issue, own, deps);
    }
    const targets: PrerequisiteStackTarget[] = [];
    for (const prerequisite of open) {
      const target = await openFactoryPr(prerequisite, deps);
      if (!target) return undefined;
      targets.push(target);
    }
    const choice = await choosePrerequisiteStack(targets, (sha, branch) => deps.branchContains(sha, branch));
    return choice.kind === 'stack' ? { kind: 'build', stackOn: choice.on } : undefined;
  } catch {
    return undefined;
  }
}

/** For an issue's open PR stacked on a prerequisite (body marker, base not main): restack, hold or wait. A stacked PR is
 *  never adopted for landing. Undefined when the PR is not a prerequisite stack. Throws on a failed lookup. */
export async function stackedPullDecision(
  issue: number,
  pr: OpenPullRequestEvidence,
  deps: StackDeps,
): Promise<QueuePreflightDecision | undefined> {
  const refs = await deps.getPullRefs(pr.number);
  const target = parsePrerequisiteStackMarker(refs.body ?? '');
  if (!target || refs.baseRef === 'main') return undefined;
  const state = await deps.getPullState(target.prNumber);
  if (state === 'closed') {
    return {
      kind: 'held',
      reason: `prerequisite PR #${target.prNumber} (issue #${target.issue}) was closed without merging`,
      prerequisitePr: target.prNumber,
    };
  }
  const prerequisiteHead = (await deps.getPullRefs(target.prNumber)).headSha;
  const restack = { kind: 'restack-prerequisite', prNumber: pr.number, branch: pr.branch, recordedHead: pr.headSha };
  if (state === 'merged') {
    return {
      ...restack,
      kind: 'restack-prerequisite',
      stackedOn: target,
      onto: { kind: 'main', mergedHead: prerequisiteHead },
    };
  }
  if (prerequisiteHead !== target.headSha) {
    return {
      ...restack,
      kind: 'restack-prerequisite',
      stackedOn: target,
      onto: { kind: 'prerequisite', newHead: prerequisiteHead },
    };
  }
  deps.onDeferred?.(issue, `stacked on prerequisite PR #${target.prNumber}; waiting for it to merge`);
  return { kind: 'defer' };
}
