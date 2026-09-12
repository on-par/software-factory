import { useEffect, useState } from 'react';

import { fetchRepos, REPO_STATE_LABEL, type RepoListOutcome, type RepoState } from './repoListing.js';

export interface RepoListProps {
  /** Injectable seam — defaults to the real client. */
  load?: () => Promise<RepoListOutcome>;
  /** Bumped by a successful attach; any change re-reads the registry. */
  refreshKey?: number;
}

const STATE_CHIP_CLASS: Record<RepoState, string> = {
  active: 'bg-teal-500 text-white',
  paused: 'bg-hairline text-ink-600',
  draining: 'bg-hairline text-ink-600',
  detached: 'bg-hairline text-ink-600',
};

export function RepoList({ load = fetchRepos, refreshKey = 0 }: RepoListProps) {
  const [outcome, setOutcome] = useState<RepoListOutcome | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOutcome(null);
    void load().then((result) => {
      if (!cancelled) setOutcome(result);
    });
    return () => {
      cancelled = true;
    };
  }, [load, refreshKey]);

  return (
    <section aria-label="Attached repositories" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">Repositories</h3>
      {outcome === null && <p className="text-sm text-ink-400">Loading repositories…</p>}
      {outcome?.ok === false && (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-hairline bg-status-failed/10 p-2">
          <h4 className="text-sm font-semibold text-ink-900">Repository list unavailable</h4>
          <p className="text-xs text-ink-600">Start the daemon (`factory daemon run`) and try again.</p>
          <p className="font-mono text-[11px] text-ink-400">{outcome.error}</p>
        </div>
      )}
      {outcome?.ok === true && outcome.repos.length === 0 && (
        <p className="text-sm text-ink-400">No repositories attached yet.</p>
      )}
      {outcome?.ok === true && outcome.repos.length > 0 && (
        <ul className="flex flex-col gap-1">
          {outcome.repos.map((repo) => (
            <li
              key={repo.slug}
              className="flex flex-col gap-0.5 rounded-md border border-hairline bg-white p-2 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-900">{repo.slug}</span>
                <span className={`rounded-sm px-1.5 py-0.5 text-[11px] font-medium ${STATE_CHIP_CLASS[repo.state]}`}>
                  {REPO_STATE_LABEL[repo.state]}
                </span>
              </div>
              <span className="font-mono text-[11px] text-ink-400">{repo.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
