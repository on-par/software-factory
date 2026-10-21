// src/phases/stack-order.ts — stack mode (ADR-0161): where a slice PR sits in its stack, as a marked body line.

import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { stackSliceBranch, type SlicePlan } from '../readiness/slice-plan.js';

export const STACK_ORDER_MARKER = '<!-- factory:stack-order -->';

const STACK_BASE_BRANCH = 'main';

export interface StackPosition {
  /** 1-based slice index. */
  index: number;
  count: number;
  /** Branch the PR opens against: `main` for slice 1, the parent slice branch otherwise. */
  base: string;
  /** PR number of the parent slice, when the slice plan records one. */
  basePr?: number;
  next?: { branch: string; prNumber?: number };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function stackPositionFor(plan: SlicePlan, index: number, parentBaseRef: string | undefined): StackPosition {
  const count = plan.slices.length;
  const base = index === 1 || parentBaseRef === undefined ? STACK_BASE_BRANCH : parentBaseRef.replace(/^origin\//, '');
  const basePr = plan.slices.find((s) => s.index === index - 1)?.prNumber;
  return {
    index,
    count,
    base,
    ...(basePr === undefined ? {} : { basePr }),
    ...(index < count ? { next: { branch: stackSliceBranch(plan.issue, index + 1) } } : {}),
  };
}

/** The position of slice `index` once its parent is squash-merged: stacked on `main` with no parent PR (#3368). */
export function retargetedStackPosition(plan: SlicePlan, index: number): StackPosition {
  const { basePr: _basePr, ...position } = stackPositionFor(plan, index, undefined);
  const nextPr = plan.slices.find((s) => s.index === index + 1)?.prNumber;
  return position.next && nextPr !== undefined
    ? { ...position, next: { ...position.next, prNumber: nextPr } }
    : position;
}

export function renderStackOrderLine(p: StackPosition): string {
  const stackedOn = p.basePr ? `#${p.basePr} (\`${p.base}\`)` : `\`${p.base}\``;
  const next = p.next
    ? `; next: slice ${p.index + 1} ${p.next.prNumber ? `#${p.next.prNumber}` : `(\`${p.next.branch}\`)`}`
    : ' (top of stack)';
  return `${STACK_ORDER_MARKER}\n**Stack:** slice ${p.index}/${p.count} — stacked on ${stackedOn}${next}`;
}

/** Replaces the marker line and the line after it; without a marker, inserts after the Summary paragraph or appends. */
export function replaceStackOrderLine(body: string, line: string): string {
  const lines = body.split('\n');
  const at = lines.indexOf(STACK_ORDER_MARKER);
  if (at >= 0) {
    lines.splice(at, 2, ...line.split('\n'));
    return lines.join('\n');
  }
  const summary = lines.findIndex((l) => l.trim() === '## Summary');
  if (summary >= 0) {
    let end = summary + 1;
    while (end < lines.length && lines[end]!.trim() !== '') end++;
    lines.splice(end, 0, '', ...line.split('\n'));
    return lines.join('\n');
  }
  return `${body.trimEnd()}\n\n${line}\n`;
}

/** Rewrites slice k-1's PR so it names slice k's PR as next. Best-effort: never throws. */
export async function updateParentStackOrder(opts: {
  octokit: Octokit;
  repo: string;
  plan: SlicePlan;
  index: number;
  prNumber: number;
  log: (type: EventKind, msg: string) => void;
}): Promise<void> {
  const { octokit, repo, plan, index, prNumber, log } = opts;
  if (index <= 1) return;
  const parent = plan.slices.find((s) => s.index === index - 1);
  if (parent?.prNumber === undefined || parent.state === 'merged') return;
  try {
    const [owner, repoName] = repo.split('/') as [string, string];
    const grandparent = plan.slices.find((s) => s.index === index - 2);
    const position: StackPosition = {
      index: index - 1,
      count: plan.slices.length,
      base: index - 1 === 1 ? STACK_BASE_BRANCH : stackSliceBranch(plan.issue, index - 2),
      ...(grandparent?.prNumber === undefined ? {} : { basePr: grandparent.prNumber }),
      next: { branch: stackSliceBranch(plan.issue, index), prNumber },
    };
    const { data } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: parent.prNumber });
    const body = replaceStackOrderLine(data.body ?? '', renderStackOrderLine(position));
    await octokit.rest.pulls.update({ owner, repo: repoName, pull_number: parent.prNumber, body });
  } catch (err) {
    log('ship', `could not update the stack order on slice ${index - 1} PR #${parent.prNumber}: ${errorMessage(err)}`);
  }
}
