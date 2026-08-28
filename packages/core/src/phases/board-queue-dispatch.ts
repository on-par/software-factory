// packages/core/src/phases/board-queue-dispatch.ts — Apply read-only board intent to local lane candidates (#848).

import type { QueueIntentSnapshot } from '../queue/project-board-poller.js';

/** The minimal locally-authoritative record that may be dispatched to a lane. */
export interface LocalLaneCandidate {
  readonly issueNumber: number;
}

/** Supplies the latest successfully normalized board queue intent. */
export interface QueueIntentReader {
  snapshot(): QueueIntentSnapshot | null;
}

/** Explicitly selects how eligible local candidates are ranked. */
export type BoardQueueOrdering =
  { readonly kind: 'board' } | { readonly kind: 'priority'; readonly priorityValues: readonly (string | number)[] };

export interface BoardQueueDispatcher {
  next(lane: string, candidates: readonly LocalLaneCandidate[]): LocalLaneCandidate | null;
}

interface RankedIntent {
  readonly boardOrder: number;
  readonly priority: string | number | null;
}

function rankedIntentMembership(snapshot: QueueIntentSnapshot, lane: string): Map<number, RankedIntent> {
  const membership = new Map<number, RankedIntent>();

  snapshot.items.forEach((item, boardOrder) => {
    if (item.issueNumber === null || item.status !== 'queued' || item.lane !== lane) return;
    if (!membership.has(item.issueNumber)) membership.set(item.issueNumber, { boardOrder, priority: item.priority });
  });

  return membership;
}

function priorityRanks(priorityValues: readonly (string | number)[]): Map<string | number, number> {
  const ranks = new Map<string | number, number>();
  priorityValues.forEach((priority, rank) => {
    if (!ranks.has(priority)) ranks.set(priority, rank);
  });
  return ranks;
}

export function createBoardQueueDispatcher(
  intent: QueueIntentReader,
  ordering: BoardQueueOrdering,
): BoardQueueDispatcher {
  const configuredPriorityRanks = ordering.kind === 'priority' ? priorityRanks(ordering.priorityValues) : undefined;

  return {
    next(lane, candidates) {
      const snapshot = intent.snapshot();
      if (snapshot === null) return null;

      const membership = rankedIntentMembership(snapshot, lane);
      let selected: LocalLaneCandidate | null = null;
      let selectedIntent: RankedIntent | undefined;

      for (const candidate of candidates) {
        const candidateIntent = membership.get(candidate.issueNumber);
        if (candidateIntent === undefined) continue;

        if (selectedIntent === undefined || ranksBefore(candidateIntent, selectedIntent, configuredPriorityRanks)) {
          selected = candidate;
          selectedIntent = candidateIntent;
        }
      }

      return selected;
    },
  };
}

function ranksBefore(
  candidate: RankedIntent,
  selected: RankedIntent,
  configuredPriorityRanks: ReadonlyMap<string | number, number> | undefined,
): boolean {
  if (configuredPriorityRanks !== undefined) {
    const candidatePriorityRank =
      candidate.priority === null ? undefined : configuredPriorityRanks.get(candidate.priority);
    const selectedPriorityRank =
      selected.priority === null ? undefined : configuredPriorityRanks.get(selected.priority);
    const candidateConfigured = candidatePriorityRank !== undefined;
    const selectedConfigured = selectedPriorityRank !== undefined;

    if (candidateConfigured !== selectedConfigured) return candidateConfigured;
    if (candidateConfigured && selectedConfigured && candidatePriorityRank !== selectedPriorityRank) {
      return candidatePriorityRank < selectedPriorityRank;
    }
  }

  return candidate.boardOrder < selected.boardOrder;
}
