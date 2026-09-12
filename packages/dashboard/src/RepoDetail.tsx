import { ConnectionChip, LaneCardView } from './LaneBoard.js';
import type { LaneBoardState } from './laneBoardState.js';
import type { ConnectionState } from './useLaneEvents.js';

export interface RepoDetailProps {
  repo: string;
  board: LaneBoardState;
  connection: ConnectionState;
}

export function RepoDetail({ repo, board, connection }: RepoDetailProps) {
  return (
    <section aria-label={`Repo detail ${repo}`} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-ink-900">{repo}</h3>
          <a href="?" className="text-xs font-medium text-ink-400 hover:text-ink-900">
            ← All repos
          </a>
        </div>
        <ConnectionChip connection={connection} />
      </div>
      {board.lanes.length === 0 ? (
        <p className="text-sm text-ink-400">No lanes for {repo} yet…</p>
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
