// packages/core/src/queue/prerequisite-stack.ts — cross-issue stacks (#3916, ADR-0161 addendum): pick the open
// prerequisite PR to stack on, and the body marker that records what a stacked PR sits on.

import { defaultFactoryConfig } from '@on-par/factory-config';

import type { FactoryConfig } from '../config/index.js';

/** An open factory PR for a prerequisite issue that a dependent issue can stack on. */
export interface PrerequisiteStackTarget {
  /** The prerequisite issue number. */
  issue: number;
  prNumber: number;
  branch: string;
  headSha: string;
}

/** Preflight: the stacked PR sits on a merged or moved prerequisite and must be rebased (#3916). */
export interface PrerequisiteRestackDecision {
  kind: 'restack-prerequisite';
  prNumber: number;
  branch: string;
  recordedHead: string;
  stackedOn: PrerequisiteStackTarget;
  onto: { kind: 'main'; mergedHead: string } | { kind: 'prerequisite'; newHead: string };
}

/** Preflight: the prerequisite PR closed unmerged, so the stacked issue parks held (#3916). */
export interface PrerequisiteHeldDecision {
  kind: 'held';
  reason: string;
  prerequisitePr: number;
}

/** The cross-issue stack decisions preflight adds to the queue's decision union. */
export type PrerequisiteQueueDecision = PrerequisiteRestackDecision | PrerequisiteHeldDecision;

export type PrerequisiteStackChoice =
  { kind: 'stack'; on: PrerequisiteStackTarget } | { kind: 'defer'; reason: string };

/** Whether `queue.stackOnOpenPrerequisite` allows stacking (default on; a non-boolean value is the default). */
export function resolveQueueStackOnOpenPrerequisite(config: FactoryConfig): boolean {
  return config.queue?.stackOnOpenPrerequisite ?? defaultFactoryConfig.queue.stackOnOpenPrerequisite;
}

/** One target stacks. Several stack on the one whose branch contains every other target's head; otherwise defer. */
export async function choosePrerequisiteStack(
  open: readonly PrerequisiteStackTarget[],
  contains: (ancestorSha: string, branch: string) => Promise<boolean>,
): Promise<PrerequisiteStackChoice> {
  if (open.length === 1) return { kind: 'stack', on: open[0]! };
  for (const candidate of open) {
    let tip = true;
    for (const other of open) {
      if (other === candidate) continue;
      if (!(await contains(other.headSha, candidate.branch))) {
        tip = false;
        break;
      }
    }
    if (tip) return { kind: 'stack', on: candidate };
  }
  return {
    kind: 'defer',
    reason: `open prerequisites ${open.map((t) => `#${t.issue}`).join(', ')} are not on one chain; none contains the others`,
  };
}

const MARKER_RE =
  /<!-- factory:prerequisite-stack issue:(\d+) pr:(\d+) branch:(factory\/(\d+)-[A-Za-z0-9._/-]*) head:([0-9a-f]{40}) -->/;

export function renderPrerequisiteStackMarker(on: PrerequisiteStackTarget): string {
  return `<!-- factory:prerequisite-stack issue:${on.issue} pr:${on.prNumber} branch:${on.branch} head:${on.headSha} -->`;
}

/** Parses the marker; undefined unless the branch is `factory/<issue>-…` for the same issue and the head is 40-hex. */
export function parsePrerequisiteStackMarker(body: string): PrerequisiteStackTarget | undefined {
  const m = MARKER_RE.exec(body);
  if (!m || m[1] !== m[4]) return undefined;
  return { issue: Number(m[1]), prNumber: Number(m[2]), branch: m[3]!, headSha: m[5]! };
}
