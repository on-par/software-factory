import {
  BOARD_PHASES,
  groupLanesByRepo,
  laneStatusChip,
  type LaneBoardState,
  type LaneCard,
  type PhaseSegmentState,
  type RepoLaneGroup,
} from './laneBoardState.js';
import { UsageHeadroom } from './UsageHeadroom.js';
import type { UsageHeadroomReading } from './usageHeadroomState.js';

export type ConnectionState = 'connecting' | 'live' | 'disconnected';

export interface LaneBoardProps {
  board: LaneBoardState;
  connection: ConnectionState;
  /** Attached repo slugs from injected config — seeds an idle section for a repo with no lane
   *  events yet. See ADR-0038/ADR-0039: this is config, never a network read. */
  attachedRepos?: readonly string[];
  /** Current usage reading, or `null` when no usage signal is available. Optional so
   *  existing call sites (RepoDetail's chip/card reuse, tests) are unchanged. */
  usage?: UsageHeadroomReading | null;
}

export const CONNECTION_CHIP: Record<ConnectionState, { label: string; className: string }> = {
  connecting: { label: 'Connecting…', className: 'bg-status-queued' },
  live: { label: 'Live', className: 'bg-teal-500' },
  disconnected: { label: 'Disconnected', className: 'bg-status-failed' },
};

export function ConnectionChip({ connection }: { connection: ConnectionState }) {
  const chip = CONNECTION_CHIP[connection];
  return (
    <span role="status" className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-white ${chip.className}`}>
      {chip.label}
    </span>
  );
}

const BAR_CLASS_BY_SEGMENT: Record<PhaseSegmentState, string> = {
  pending: 'bg-hairline',
  active: 'bg-status-building',
  done: 'bg-status-shipped',
  failed: 'bg-status-failed',
};

export function LaneCardView({ card }: { card: LaneCard }) {
  return (
    <article
      aria-label={`Lane ${card.laneId}`}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-hairline bg-white p-2"
    >
      <div className="flex min-w-0 items-start justify-between gap-1">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold text-ink-900">Issue #{card.issueId}</h4>
          <p className="truncate text-xs text-ink-400">{card.laneId}</p>
        </div>
        <span
          role="status"
          className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${laneStatusChip(card).className}`}
        >
          {laneStatusChip(card).label}
        </span>
      </div>
      <ol aria-label="Pipeline progress" className="flex gap-0.5">
        {BOARD_PHASES.map((phase) => {
          const segmentState = card.segments[phase];
          return (
            <li key={phase} className="min-w-0 flex-1" aria-current={segmentState === 'active' ? 'step' : undefined}>
              <span className="block truncate text-[10px] font-medium uppercase text-ink-600">{phase}</span>
              <span
                aria-label={`${phase} ${segmentState}`}
                className={`block h-1 rounded-sm ${BAR_CLASS_BY_SEGMENT[segmentState]}`}
              />
            </li>
          );
        })}
      </ol>
      <ul
        aria-label="Log tail"
        className="max-h-24 overflow-y-auto rounded-sm bg-canvas p-1 font-mono text-[11px] text-ink-600"
      >
        {card.log.map((line, index) => (
          <li key={index} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </article>
  );
}

function RepoGroupView({ group }: { group: RepoLaneGroup }) {
  const idle = group.lanes.length === 0;

  return (
    <section aria-label={`Repo ${group.repo}`} className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-600">{group.repo}</h4>
        {idle && (
          <span role="status" className="rounded-sm bg-hairline px-1.5 py-0.5 text-[11px] font-medium text-ink-600">
            Idle
          </span>
        )}
      </div>
      {idle ? (
        <p className="text-sm text-ink-400">No active lanes.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {group.lanes.map((card) => (
            <li key={card.laneId}>
              <LaneCardView card={card} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LaneBoard({ board, connection, attachedRepos = [], usage = null }: LaneBoardProps) {
  const groups = groupLanesByRepo(board.lanes, attachedRepos);

  return (
    <section aria-label="Lane status board" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Lanes</h3>
        <ConnectionChip connection={connection} />
      </div>
      <UsageHeadroom usage={usage} />
      {groups.length === 0 ? (
        <p className="text-sm text-ink-400">Waiting for lane events…</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <RepoGroupView key={group.repo} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}
