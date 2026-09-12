import { useEffect, useState } from 'react';
import type { JSX } from 'react';

import type { EffectivePolicyField, SafeRepoPolicySnapshot } from '@on-par/factory-core';

export interface RepoPolicySnapshot extends SafeRepoPolicySnapshot {
  repo: string;
}

export interface RepoPolicyClient {
  load(): Promise<RepoPolicySnapshot>;
  save(field: string, value: boolean, confirmationToken?: string): Promise<RepoPolicySnapshot>;
}

interface RepoListing {
  slug: string;
  state: string;
}

/** Wraps `fetch` against the factoryd control plane (proxied at /repos in dev,
 *  same-origin in production): GET /repos picks the attached repo, then
 *  GET/PUT /repos/<slug>/policy read and persist the effective snapshot. */
export function createRepoPolicyClient(fetchImpl: typeof fetch = globalThis.fetch): RepoPolicyClient {
  let slug: string | undefined;

  async function resolveSlug(): Promise<string> {
    if (slug !== undefined) return slug;
    const res = await fetchImpl('/repos');
    if (!res.ok) throw new Error(`factoryd responded ${res.status}`);
    const { repos } = (await res.json()) as { repos: RepoListing[] };
    const chosen = repos.find((r) => r.state === 'active') ?? repos[0];
    if (!chosen) throw new Error('No repo attached — attach a repo to edit policy.');
    slug = chosen.slug;
    return slug;
  }

  return {
    async load(): Promise<RepoPolicySnapshot> {
      const repoSlug = await resolveSlug();
      const res = await fetchImpl(`/repos/${repoSlug}/policy`);
      if (!res.ok) throw new Error(`factoryd responded ${res.status}`);
      return (await res.json()) as RepoPolicySnapshot;
    },
    async save(field: string, value: boolean, confirmationToken?: string): Promise<RepoPolicySnapshot> {
      const repoSlug = await resolveSlug();
      const res = await fetchImpl(`/repos/${repoSlug}/policy`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ field, value, confirmationToken }),
      });
      if (!res.ok) throw new Error(`factoryd responded ${res.status}`);
      return (await res.json()) as RepoPolicySnapshot;
    },
  };
}

function sourceLabel(field: EffectivePolicyField): string {
  switch (field.source) {
    case 'flag':
      return `CLI flag ${field.sourceDetail}`;
    case 'env':
    case 'config':
      return field.sourceDetail;
    case 'default':
      return 'built-in default';
  }
}

export function SettingsView({ client }: { client: RepoPolicyClient }): JSX.Element {
  const [snapshot, setSnapshot] = useState<RepoPolicySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<EffectivePolicyField | null>(null);
  const [auditNotice, setAuditNotice] = useState<string | null>(null);

  useEffect(() => {
    client
      .load()
      .then((s) => setSnapshot(s))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [client]);

  async function applyToggle(field: EffectivePolicyField, confirmationToken?: string): Promise<void> {
    setSaving(field.id);
    try {
      const next = await client.save(field.id, !field.value, confirmationToken);
      setSnapshot(next);
      setError(null);
      setAuditNotice(confirmationToken !== undefined ? (field.confirmEnable?.auditText ?? null) : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
      setPendingConfirm(null);
    }
  }

  // Enabling a `confirmEnable` field (e.g. admin-merge) stops here for a distinct
  // confirmation step instead of saving immediately — disabling and every other field
  // still save on the first click (#1390).
  function handleToggle(field: EffectivePolicyField): void {
    if (!field.value && field.confirmEnable) {
      setPendingConfirm(field);
      return;
    }
    void applyToggle(field);
  }

  return (
    <section aria-label="Settings" className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-ink-900">Settings</h3>
      {error !== null && <p role="alert">{error}</p>}
      {auditNotice !== null && <p role="status">{auditNotice}</p>}
      {snapshot === null ? (
        <p>Loading settings…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-ink-600">
            {snapshot.repo} — {snapshot.configPath}
          </p>
          {snapshot.fields.map((field) => (
            <div key={field.id} className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={field.value}
                  disabled={!field.editable || saving === field.id}
                  onChange={() => handleToggle(field)}
                />
                {field.label}
              </label>
              <p className="text-xs text-ink-600">{field.description}</p>
              <p className="text-xs text-ink-400">Source: {sourceLabel(field)}</p>
              {!field.editable && (
                <span className="text-xs text-ink-400">
                  Set by {field.source === 'flag' ? 'a CLI flag' : 'an environment variable'} — edit it there.
                </span>
              )}
              {pendingConfirm?.id === field.id && field.confirmEnable !== undefined && (
                <div
                  role="alertdialog"
                  aria-label={`Confirm enabling ${field.label}`}
                  className="flex flex-col gap-2 rounded border border-ink-400 p-2 text-xs"
                >
                  <p>
                    This explicitly enables the {field.label.toLowerCase()} bypass: {field.confirmEnable.auditText}.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void applyToggle(field, field.confirmEnable?.token);
                      }}
                    >
                      Enable bypass
                    </button>
                    <button type="button" onClick={() => setPendingConfirm(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
