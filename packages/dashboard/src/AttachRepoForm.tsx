import { useState } from 'react';

import { attachRepo, type AttachRepoInput, type AttachRepoOutcome } from './repoAttach.js';

export interface AttachRepoFormProps {
  /** Injectable seam — defaults to the real client. */
  attach?: (input: AttachRepoInput) => Promise<AttachRepoOutcome>;
}

export function AttachRepoForm({ attach = attachRepo }: AttachRepoFormProps) {
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AttachRepoOutcome | null>(null);

  const trimmedRepo = repo.trim();
  const trimmedPath = path.trim();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setOutcome(null);
    void (async () => {
      const result = await attach({ repo: trimmedRepo, path: trimmedPath });
      setOutcome(result);
      setBusy(false);
    })();
  }

  return (
    <section aria-label="Attach a repository" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">Attach a repository</h3>
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 rounded-md border border-hairline bg-white p-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="attach-repo-slug" className="text-xs text-ink-400">
            GitHub repo (owner/name)
          </label>
          <input
            id="attach-repo-slug"
            type="text"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="on-par/software-factory"
            className="rounded-md border border-hairline p-2 text-sm"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="attach-repo-path" className="text-xs text-ink-400">
            Local checkout path
          </label>
          <input
            id="attach-repo-path"
            type="text"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/Users/you/repos/software-factory"
            className="rounded-md border border-hairline p-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={busy || trimmedRepo === '' || trimmedPath === ''}
          className="self-start rounded-md bg-navy-950 px-2 py-1 text-sm font-medium text-white disabled:opacity-50"
        >
          Attach repo
        </button>
      </form>
      {outcome?.ok === false && (
        <div role="alert" className="flex flex-col gap-1 rounded-md border border-hairline bg-status-failed/10 p-2">
          <h4 className="text-sm font-semibold text-ink-900">{outcome.explanation.title}</h4>
          <p className="text-xs text-ink-600">{outcome.explanation.remediation}</p>
          <p className="font-mono text-[11px] text-ink-400">{outcome.explanation.detail}</p>
        </div>
      )}
      {outcome?.ok === true && <p role="status">Attached {outcome.slug}.</p>}
    </section>
  );
}
