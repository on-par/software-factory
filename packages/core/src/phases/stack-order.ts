import type { Octokit } from '@octokit/rest';

import type { EventKind } from '../events/kinds.js';
import { renderPrerequisiteStackMarker, type PrerequisiteStackTarget } from '../queue/prerequisite-stack.js';
import { stackSliceBranch, type SlicePlan } from '../readiness/slice-plan.js';

export const STACK_ORDER_MARKER = '<!-- factory:stack-order -->';

const STACK_BASE_BRANCH = 'main';

export interface StackPosition {
  index: number;
  count: number;
  base: string;
  basePr?: number;
  next?: { branch: string; prNumber?: number };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function stackPositionFor(plan: SlicePlan, index: number, parentBaseRef: string | undefined): StackPosition {
  const count = plan.slices.length;
  const base = parentBaseRef === undefined ? STACK_BASE_BRANCH : parentBaseRef.replace(/^origin\//, '');
  const basePr = plan.slices.find((s) => s.index === index - 1)?.prNumber;
  return {
    index,
    count,
    base,
    ...(basePr === undefined ? {} : { basePr }),
    ...(index < count ? { next: { branch: stackSliceBranch(plan.issue, index + 1) } } : {}),
  };
}

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

export function renderPrerequisiteStackLine(p: {
  prerequisite: PrerequisiteStackTarget;
  issue: number;
  base: string;
}): string {
  const { prerequisite: b } = p;
  const tail = p.base === STACK_BASE_BRANCH ? '(prerequisite merged; stacked on `main`)' : `— stacked on \`${p.base}\``;
  return `${STACK_ORDER_MARKER}\n**Stack:** #${b.issue} PR #${b.prNumber} (\`${b.branch}\`), then #${p.issue} ${tail}`;
}

export function prerequisiteStackOrder(
  prerequisite: PrerequisiteStackTarget | undefined,
  issue: number | string,
  base: string,
): string | undefined {
  if (prerequisite === undefined) return undefined;
  return `${renderPrerequisiteStackLine({ prerequisite, issue: Number(issue), base })}\n${renderPrerequisiteStackMarker(prerequisite)}`;
}

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
