import {
  BOARD_PHASES,
  laneStatusChip,
  type LaneBoardState,
  type LaneCard,
  type PhaseSegmentState,
} from './laneBoardState.js';

export type ConnectionState = 'connecting' | 'live' | 'disconnected';

export interface LaneBoardProps {
  board: LaneBoardState;
  connection: ConnectionState;
}

const CONNECTION_CHIP: Record<ConnectionState, { label: string; className: string }> = {
  connecting: { label: 'Connecting…', className: 'bg-status-queued' },
  live: { label: 'Live', className: 'bg-teal-500' },
  disconnected: { label: 'Disconnected', className: 'bg-status-failed' },
};

const BAR_CLASS_BY_SEGMENT: Record<PhaseSegmentState, string> = {
  pending: 'bg-hairline',
  active: 'bg-status-building',
  done: 'bg-status-shipped',
  failed: 'bg-status-failed',
};

function LaneCardView({ card }: { card: LaneCard }) {
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

export function LaneBoard({ board, connection }: LaneBoardProps) {
  const chip = CONNECTION_CHIP[connection];

  return (
    <section aria-label="Lane status board" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Lanes</h3>
        <span role="status" className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium text-white ${chip.className}`}>
          {chip.label}
        </span>
      </div>
      {board.lanes.length === 0 ? (
        <p className="text-sm text-ink-400">Waiting for lane events…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {board.lanes.map((card) => (
            <li key={card.laneId}>
              <LaneCardView card={card} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
