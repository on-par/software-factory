import type { LaneLifecyclePhase } from '@on-par/contracts';

import { BOARD_PHASES, type LaneCard, type PhaseSegment } from './laneBoardState.js';

export type LaneVisualState = 'active' | 'waiting-merge' | 'parked' | 'stale' | 'shipped' | 'failed';

/** Mirrors core's DEFAULT_QUEUE_ACTIVITY_STALE_THRESHOLD_MS (15 min, ADR-0086/ADR-0093).
 *  Duplicated because that export lives behind @on-par/factory-core's Node-only root entry
 *  point, which a browser bundle cannot import — see the ADR shipped with this change. */
export const STALE_AFTER_MS = 15 * 60_000;

export interface PhaseProgress {
  phase: LaneLifecyclePhase;
  segment: PhaseSegment;
  /** Absent while the phase is pending. Frozen once the phase ended. */
  elapsedLabel?: string;
}

export interface LaneNextAction {
  label: string;
  href: string;
  hint: string;
}

export interface LaneProgress {
  state: LaneVisualState;
  /** Chip text, e.g. 'waiting-merge', 'parked', 'stale', 'build…', 'shipped', 'failed'. */
  label: string;
  /** Tailwind classes for the chip. */
  className: string;
  elapsedLabel: string;
  phases: PhaseProgress[];
  /** Present only when state === 'parked': the frame's own detail. */
  parkReason?: string;
  /** Present only when state === 'parked'. */
  nextAction?: LaneNextAction;
}

export function formatElapsed(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

const LABEL_AND_CLASS_BY_STATE: Record<LaneVisualState, { label: string; className: string }> = {
  active: { label: '', className: 'bg-status-building text-navy-950' },
  shipped: { label: 'shipped', className: 'bg-status-shipped text-white' },
  failed: { label: 'failed', className: 'bg-status-failed text-white' },
  'waiting-merge': { label: 'waiting-merge', className: 'bg-status-checking text-navy-950' },
  parked: { label: 'parked', className: 'bg-status-parked text-navy-950' },
  stale: { label: 'stale', className: 'bg-status-queued text-white' },
};

function activeLabel(card: LaneCard): string {
  return card.status === 'done' ? `${card.phase} done` : `${card.phase}…`;
}

export function laneProgress(card: LaneCard, now: number, staleAfterMs = STALE_AFTER_MS): LaneProgress {
  const terminal =
    card.laneState === 'parked' || card.status === 'failed' || (card.status === 'done' && card.phase === 'ship');
  const lastFrameMs = Date.parse(card.updatedAt);
  const stale = !terminal && now - lastFrameMs > staleAfterMs;

  let state: LaneVisualState;
  if (card.laneState === 'parked') state = 'parked';
  else if (card.status === 'failed') state = 'failed';
  else if (card.status === 'done' && card.phase === 'ship') state = 'shipped';
  else if (stale) state = 'stale';
  else if (card.laneState === 'waiting-merge') state = 'waiting-merge';
  else state = 'active';

  const { label, className } = LABEL_AND_CLASS_BY_STATE[state];

  const end = terminal ? lastFrameMs : now;
  const elapsedLabel = formatElapsed(end - Date.parse(card.startedAt));

  const phases: PhaseProgress[] = BOARD_PHASES.map((phase) => {
    const segment = card.segments[phase];
    if (segment.startedAt === undefined) return { phase, segment };
    const segmentEnd = segment.endedAt ? Date.parse(segment.endedAt) : now;
    return { phase, segment, elapsedLabel: formatElapsed(segmentEnd - Date.parse(segment.startedAt)) };
  });

  const progress: LaneProgress = {
    state,
    label: state === 'active' ? activeLabel(card) : label,
    className,
    elapsedLabel,
    phases,
  };

  if (state === 'parked') {
    progress.parkReason = card.detail;
    progress.nextAction = {
      label: 'Open lane worktree',
      href: `file://${card.worktreePath}`,
      hint: 'Parked for a human — inspect the worktree, clear the blocker, then rerun the lane.',
    };
  }

  return progress;
}
