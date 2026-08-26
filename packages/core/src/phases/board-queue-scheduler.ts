// packages/core/src/phases/board-queue-scheduler.ts — Schedule local candidates from ProjectV2 queue intent (#867).

import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { ProjectQueueStatus } from '../projects/project-queue-reader.js';
import type { LocalLaneCandidate } from './board-queue-dispatch.js';

/** Supplies the latest successfully projected ProjectV2 queue intent. */
export interface ProjectQueueProjectionReader {
  snapshot(): ProjectQueueProjection | null;
}

/** Daemon-owned policy and read-only board projection used for scheduling. */
export interface BoardQueueSchedulerOptions {
  readonly projectionReader: ProjectQueueProjectionReader;
  readonly dispatchableStatuses: readonly ProjectQueueStatus[];
}

/** Groups locally-authoritative candidates by their current projected lane. */
export interface BoardQueueScheduler {
  snapshot(): ProjectQueueProjection | null;
  select(candidates: readonly LocalLaneCandidate[]): ReadonlyMap<string, readonly LocalLaneCandidate[]>;
}

interface ProjectedCandidate {
  readonly lane: string;
  readonly order: string | number;
  readonly projectionOrder: number;
}

function compareOrder(first: string | number, second: string | number): number {
  if (first === second) return 0;
  if (typeof first === 'number' && typeof second === 'number') return first < second ? -1 : 1;
  const firstValue = String(first);
  const secondValue = String(second);
  if (firstValue === secondValue) return 0;
  return firstValue < secondValue ? -1 : 1;
}

function projectedCandidates(
  projection: ProjectQueueProjection,
  dispatchableStatuses: ReadonlySet<ProjectQueueStatus>,
): ReadonlyMap<number, ProjectedCandidate> {
  const projected = new Map<number, ProjectedCandidate>();

  projection.items.forEach((item, projectionOrder) => {
    if (!dispatchableStatuses.has(item.status) || projected.has(item.issue.number)) return;
    projected.set(item.issue.number, { lane: item.lane, order: item.order, projectionOrder });
  });

  return projected;
}

export function createBoardQueueScheduler(options: BoardQueueSchedulerOptions): BoardQueueScheduler {
  const dispatchableStatuses = new Set(options.dispatchableStatuses);

  return {
    snapshot() {
      return options.projectionReader.snapshot();
    },
    select(candidates) {
      const projection = options.projectionReader.snapshot();
      if (projection === null) return new Map();

      const projected = projectedCandidates(projection, dispatchableStatuses);
      const grouped = new Map<string, Array<{ candidate: LocalLaneCandidate; projected: ProjectedCandidate }>>();

      for (const candidate of candidates) {
        const candidateProjection = projected.get(candidate.issueNumber);
        if (candidateProjection === undefined) continue;

        const lane = grouped.get(candidateProjection.lane) ?? [];
        lane.push({ candidate, projected: candidateProjection });
        grouped.set(candidateProjection.lane, lane);
      }

      return new Map(
        [...grouped].map(([lane, laneCandidates]) => [
          lane,
          laneCandidates
            .sort((first, second) => {
              const orderComparison = compareOrder(first.projected.order, second.projected.order);
              return orderComparison === 0
                ? first.projected.projectionOrder - second.projected.projectionOrder
                : orderComparison;
            })
            .map(({ candidate }) => candidate),
        ]),
      );
    },
  };
}
