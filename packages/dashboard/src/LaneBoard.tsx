import type { LaneBoardState, LaneCard, PhaseSegmentState } from './laneBoardState.js';
import { laneProgress } from './laneProgress.js';

export type ConnectionState = 'connecting' | 'live' | 'disconnected';

export interface LaneBoardProps {
  board: LaneBoardState;
  connection: ConnectionState;
  now: number;
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

export function LaneCardView({ card, now }: { card: LaneCard; now: number }) {
  const progress = laneProgress(card, now);
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
        <div className="flex shrink-0 items-center gap-1">
          <span role="status" className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${progress.className}`}>
            {progress.label}
          </span>
          <span aria-label="Lane elapsed" className="text-[11px] text-ink-400">
            {progress.elapsedLabel}
          </span>
        </div>
      </div>
      <ol aria-label="Pipeline progress" className="flex gap-0.5">
        {progress.phases.map(({ phase, segment, elapsedLabel }) => (
          <li key={phase} className="min-w-0 flex-1" aria-current={segment.state === 'active' ? 'step' : undefined}>
            <span className="block truncate text-[10px] font-medium uppercase text-ink-600">{phase}</span>
            <span
              aria-label={`${phase} ${segment.state}`}
              className={`block h-1 rounded-sm ${BAR_CLASS_BY_SEGMENT[segment.state]}`}
            />
            {elapsedLabel !== undefined ? (
              <span aria-label={`${phase} elapsed`} className="block truncate text-[10px] text-ink-400">
                {elapsedLabel}
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {progress.state === 'parked' ? (
        <div role="alert" className="rounded-sm bg-status-parked/10 p-1 text-[11px] text-ink-900">
          <p>Parked — {progress.parkReason}</p>
          <p className="text-ink-600">{progress.nextAction?.hint}</p>
          {progress.nextAction ? (
            <a href={progress.nextAction.href} className="font-medium text-blue-600 hover:text-blue-700">
              {progress.nextAction.label}
            </a>
          ) : null}
        </div>
      ) : null}
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

export function LaneBoard({ board, connection, now }: LaneBoardProps) {
  return (
    <section aria-label="Lane status board" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink-900">Lanes</h3>
        <ConnectionChip connection={connection} />
      </div>
      {board.lanes.length === 0 ? (
        <p className="text-sm text-ink-400">Waiting for lane events…</p>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {board.lanes.map((card) => (
            <li key={card.laneId}>
              <LaneCardView card={card} now={now} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
