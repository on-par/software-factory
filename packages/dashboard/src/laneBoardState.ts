import {
  LANE_LIFECYCLE_PHASES,
  type LaneLifecycleEvent,
  type LaneLifecyclePhase,
  type LaneLifecycleStatus,
} from '@on-par/contracts';

export const BOARD_PHASES = LANE_LIFECYCLE_PHASES;

export const LOG_TAIL_LIMIT = 8;

/** Fallback repo key for a card whose originating frame carried no `repo` annotation. */
export const UNKNOWN_REPO = 'unknown';

export type PhaseSegmentState = 'pending' | 'active' | 'done' | 'failed';

/** `LaneLifecycleEvent` as relayed by `packages/server`'s `/events` endpoint, which tags every
 *  frame with its source repo (see `RepositoryLifecycleEvent` in `packages/server/src/sse.ts`).
 *  `repo` is optional here because `LaneLifecycleEventSchema` — the shared, server-side-authored
 *  schema — strips unknown keys, so a plain schema-validated event never carries it. */
export type RepoLaneLifecycleEvent = LaneLifecycleEvent & { repo?: string };

/** Assertion-free read of a `repo` annotation off an unknown value — used to recover it from the
 *  raw SSE payload before/alongside `LaneLifecycleEventSchema` validation, which discards it. */
export function readEventRepo(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return 'repo' in raw && typeof raw.repo === 'string' ? raw.repo : undefined;
}

export function formatLogLine(event: Pick<LaneLifecycleEvent, 'ts' | 'phase' | 'status' | 'detail'>): string {
  return `${event.ts.slice(11, 19)} ${event.phase} ${event.status} — ${event.detail}`;
}

export interface LaneCard {
  laneId: string;
  issueId: string;
  worktreePath: string;
  repo: string;
  phase: LaneLifecyclePhase;
  status: LaneLifecycleStatus;
  detail: string;
  updatedAt: string;
  segments: Record<LaneLifecyclePhase, PhaseSegmentState>;
  log: string[];
}

export interface LaneBoardState {
  lanes: LaneCard[];
}

const SEGMENT_BY_STATUS: Record<LaneLifecycleStatus, PhaseSegmentState> = {
  started: 'active',
  progress: 'active',
  done: 'done',
  failed: 'failed',
};

export function emptyLaneBoard(): LaneBoardState {
  return { lanes: [] };
}

function emptySegments(): Record<LaneLifecyclePhase, PhaseSegmentState> {
  return { plan: 'pending', build: 'pending', check: 'pending', ship: 'pending' };
}

export function reduceLaneEvent(state: LaneBoardState, event: RepoLaneLifecycleEvent): LaneBoardState {
  const existing = state.lanes.find((lane) => lane.laneId === event.laneId);
  const previousSegments = existing?.segments ?? emptySegments();
  const previousLog = existing?.log ?? [];

  const nextCard: LaneCard = {
    laneId: event.laneId,
    issueId: event.issueId,
    worktreePath: event.worktreePath,
    repo: event.repo ?? existing?.repo ?? UNKNOWN_REPO,
    phase: event.phase,
    status: event.status,
    detail: event.detail,
    updatedAt: event.ts,
    segments: { ...previousSegments, [event.phase]: SEGMENT_BY_STATUS[event.status] },
    log: [...previousLog, formatLogLine(event)].slice(-LOG_TAIL_LIMIT),
  };

  if (existing) {
    return { lanes: state.lanes.map((lane) => (lane.laneId === event.laneId ? nextCard : lane)) };
  }

  return { lanes: [...state.lanes, nextCard] };
}

export function laneStatusChip(card: LaneCard): { label: string; className: string } {
  if (card.status === 'failed') return { label: 'failed', className: 'bg-status-failed text-white' };
  if (card.status === 'done' && card.phase === 'ship') {
    return { label: 'shipped', className: 'bg-status-shipped text-white' };
  }
  if (card.status === 'done') {
    return { label: `${card.phase} done`, className: 'bg-status-checking text-navy-950' };
  }
  return { label: `${card.phase}…`, className: 'bg-status-building text-navy-950' };
}

export interface RepoLaneGroup {
  repo: string;
  lanes: LaneCard[];
}

/**
 * Groups lane cards by their source repo. `attachedRepos` seeds a group for every attached repo
 * up front, in the given order, so a repo with zero observed lane cards still renders — as idle,
 * never as absent. `App.tsx` fills this list from the persisted registry (`useAttachedRepos`,
 * ADR-0100), not from the SSE stream — ADR-0038/ADR-0039 govern the lane *set* and lane *state*,
 * not which repo slugs seed idle groups. A repo observed on the stream but missing from
 * `attachedRepos` still gets a group, appended in first-seen order, so a stale roster can never
 * hide live work.
 */
export function groupLanesByRepo(lanes: readonly LaneCard[], attachedRepos: readonly string[] = []): RepoLaneGroup[] {
  const lanesByRepo = new Map<string, LaneCard[]>();
  for (const lane of lanes) {
    const group = lanesByRepo.get(lane.repo) ?? [];
    group.push(lane);
    lanesByRepo.set(lane.repo, group);
  }

  const groups: RepoLaneGroup[] = attachedRepos.map((repo) => ({ repo, lanes: lanesByRepo.get(repo) ?? [] }));

  const seen = new Set(attachedRepos);
  for (const [repo, repoLanes] of lanesByRepo) {
    if (!seen.has(repo)) groups.push({ repo, lanes: repoLanes });
  }

  return groups;
}

/** Parses the injected `VITE_FACTORY_REPOS` config value (comma-separated repo slugs) into an
 *  ordered, de-duplicated list. Pure and network-free by construction — config, not a fetch. */
export function parseAttachedRepos(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const slug = entry.trim();
    if (slug !== '') seen.add(slug);
  }
  return [...seen];
}
