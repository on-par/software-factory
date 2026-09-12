import { useEffect, useMemo, useState } from 'react';

import { createRepoRegistryClient, type RepoListing, type RepoRegistryClient } from './repoRegistry.js';

export interface RepoLifecyclePanelProps {
  /** Injected in tests; defaults to the real same-origin factoryd client. */
  client?: RepoRegistryClient;
}

type LifecycleAction = 'pause' | 'resume' | 'detach';

function RepoRow({
  repo,
  busy,
  disabled,
  onAction,
}: {
  repo: RepoListing;
  busy: boolean;
  disabled: boolean;
  onAction: (action: LifecycleAction) => void;
}) {
  return (
    <article
      aria-label={`Repo ${repo.slug}`}
      aria-busy={busy}
      className="flex items-center justify-between gap-2 rounded-md border border-hairline bg-white p-2"
    >
      <div className="min-w-0">
        <h4 className="truncate text-sm font-semibold text-ink-900">{repo.slug}</h4>
        <p className="truncate font-mono text-xs text-ink-400">{repo.path}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span role="status" className="rounded-sm bg-status-queued px-1.5 py-0.5 text-[11px] font-medium">
          {repo.state}
        </span>
        {repo.state === 'active' && (
          <button type="button" disabled={disabled} onClick={() => onAction('pause')}>
            Pause
          </button>
        )}
        {repo.state === 'paused' && (
          <button type="button" disabled={disabled} onClick={() => onAction('resume')}>
            Resume
          </button>
        )}
        {(repo.state === 'active' || repo.state === 'paused') && (
          <button type="button" disabled={disabled} onClick={() => onAction('detach')}>
            Detach
          </button>
        )}
      </div>
    </article>
  );
}

export function RepoLifecyclePanel({ client }: RepoLifecyclePanelProps) {
  const registry = useMemo(() => client ?? createRepoRegistryClient(), [client]);
  const [repos, setRepos] = useState<RepoListing[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [busySlug, setBusySlug] = useState<string | undefined>(undefined);

  async function refresh(): Promise<void> {
    const result = await registry.list();
    if (result.ok) {
      setRepos(result.repos);
      setLoadError(undefined);
    } else {
      setLoadError(`Could not read the repo registry: ${result.error}`);
    }
  }

  useEffect(() => {
    void refresh();
  }, [registry]);

  async function runAction(slug: string, action: LifecycleAction): Promise<void> {
    setBusySlug(slug);
    setActionError(undefined);
    try {
      const result = await registry[action](slug);
      if (!result.ok) {
        setActionError(`${action} failed for ${slug}: ${result.error}`);
        return;
      }
      await refresh();
    } finally {
      setBusySlug(undefined);
    }
  }

  return (
    <section aria-label="Attached repositories" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">Repos</h3>
      {loadError !== undefined && (
        <p role="status" className="bg-status-failed text-sm text-white">
          {loadError}
        </p>
      )}
      {actionError !== undefined && (
        <p role="status" className="bg-status-failed text-sm text-white">
          {actionError}
        </p>
      )}
      {repos === undefined ? (
        <p className="text-sm text-ink-400">Loading repos…</p>
      ) : repos.length === 0 ? (
        <p className="text-sm text-ink-400">No repos attached yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {repos.map((repo) => (
            <li key={repo.slug}>
              <RepoRow
                repo={repo}
                busy={busySlug === repo.slug}
                disabled={busySlug !== undefined}
                onAction={(action) => void runAction(repo.slug, action)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
