import { AttachRepoForm } from './AttachRepoForm.js';
import { useMemo, useState } from 'react';

import { useAttachedRepos } from './attachedRepos.js';
import { KpiTrendView } from './KpiTrendView.js';
import { parseAttachedRepos } from './laneBoardState.js';
import { LaneBoard } from './LaneBoard.js';
import { RepoDetail } from './RepoDetail.js';
import { repoFromLocation } from './repoDetailState.js';
import { RepoList } from './RepoList.js';
import { createRepoPolicyClient, SettingsView } from './SettingsView.js';
import { useLaneEvents } from './useLaneEvents.js';

const NAV_ITEMS = [
  { label: 'Runs', href: '#' },
  { label: 'Issues', href: '#' },
  { label: 'Models', href: '#' },
  { label: 'Settings', href: '#settings' },
];

const ATTACHED_REPOS = parseAttachedRepos(import.meta.env.VITE_FACTORY_REPOS);

export function App() {
  const repo = repoFromLocation(window.location.search);
  const { board, connection } = useLaneEvents(repo === null ? {} : { repo });
  const policyClient = useMemo(() => createRepoPolicyClient(), []);
  const attachedRepos = useAttachedRepos(ATTACHED_REPOS);
  const [attachCount, setAttachCount] = useState(0);

  return (
    <div className="flex h-screen bg-canvas font-sans text-ink-900">
      <aside className="hidden w-30 shrink-0 overflow-y-auto bg-navy-950 text-navy-200 sm:flex flex-col">
        <nav aria-label="Primary" className="flex flex-col gap-1 p-2">
          <h1 aria-label="On Par Factory" className="px-2 py-2 leading-tight tracking-tight">
            <span className="block text-sm font-semibold text-white">On Par</span>
            <span className="block text-xs font-medium text-navy-400">Factory</span>
          </h1>
          <ul className="flex flex-col gap-1">
            {NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <a
                  href={item.href}
                  className="block rounded-md px-2 py-1 text-sm font-medium text-navy-200 hover:bg-navy-800 hover:text-white"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="flex flex-1 flex-col min-w-0">
        <header className="h-7 flex items-center border-b border-hairline bg-white px-3">
          <h2 className="text-sm font-semibold">{repo ?? 'Overview'}</h2>
        </header>
        <main className="flex-1 overflow-y-auto overflow-x-hidden bg-canvas p-2 sm:p-3">
          {repo === null ? (
            <>
              {/* No usage feed reaches the browser yet: the server relays lane lifecycle
                  frames only and factoryd exposes no usage route, so this renders the
                  explicit unavailable state. This prop is the single injection point for
                  a future factoryd-served reading. */}
              <LaneBoard board={board} connection={connection} attachedRepos={attachedRepos} usage={null} />
              <div className="mt-4">
                <RepoList refreshKey={attachCount} />
              </div>
              <div className="mt-4">
                <AttachRepoForm onAttached={() => setAttachCount((n) => n + 1)} />
              </div>
            </>
          ) : (
            <RepoDetail repo={repo} board={board} connection={connection} />
          )}
          <h3 className="mt-4 text-sm font-semibold text-ink-900">KPI trends</h3>
          <div className="mt-2">
            <KpiTrendView kpiHistoryJsonl="" />
          </div>
          <div id="settings" className="mt-4">
            <SettingsView client={policyClient} />
          </div>
        </main>
      </div>
    </div>
  );
}
