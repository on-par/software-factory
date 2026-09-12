import { useState } from 'react';

import {
  attachRepo,
  validateAttachInput,
  type AttachFieldErrors,
  type AttachRepoInput,
  type AttachRepoOutcome,
} from './repoAttach.js';

export interface AttachRepoFormProps {
  /** Injectable seam — defaults to the real client. */
  attach?: (input: AttachRepoInput) => Promise<AttachRepoOutcome>;
}

export function AttachRepoForm({ attach = attachRepo }: AttachRepoFormProps) {
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<AttachRepoOutcome | null>(null);
  const [fieldErrors, setFieldErrors] = useState<AttachFieldErrors>({});

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: AttachRepoInput = { repo: repo.trim(), path: path.trim() };
    const errors = validateAttachInput(input);
    setFieldErrors(errors);
    if (errors.repo !== undefined || errors.path !== undefined) return;

    setBusy(true);
    setOutcome(null);
    void (async () => {
      const result = await attach(input);
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
            aria-invalid={fieldErrors.repo !== undefined}
            aria-describedby={fieldErrors.repo !== undefined ? 'attach-repo-slug-error' : undefined}
            className="rounded-md border border-hairline p-2 text-sm"
          />
          {fieldErrors.repo !== undefined && (
            <p id="attach-repo-slug-error" role="alert" className="text-xs text-status-failed">
              {fieldErrors.repo}
            </p>
          )}
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
            aria-invalid={fieldErrors.path !== undefined}
            aria-describedby={fieldErrors.path !== undefined ? 'attach-repo-path-error' : undefined}
            className="rounded-md border border-hairline p-2 text-sm"
          />
          {fieldErrors.path !== undefined && (
            <p id="attach-repo-path-error" role="alert" className="text-xs text-status-failed">
              {fieldErrors.path}
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={busy}
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
