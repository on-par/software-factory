// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoList } from './RepoList.js';
import type { AttachedRepo, RepoListOutcome } from './repoListing.js';

afterEach(cleanup);

const REPO: AttachedRepo = {
  slug: 'on-par/software-factory',
  path: '/tmp/software-factory',
  attachedAt: '2026-01-01T00:00:00.000Z',
  state: 'active',
};

describe('RepoList', () => {
  it('renders "Loading repositories…" before the load resolves', () => {
    const load = vi.fn(() => new Promise<RepoListOutcome>(() => {}));
    render(<RepoList load={load} />);
    expect(screen.getByText('Loading repositories…')).toBeDefined();
  });

  it('renders one row per repo with the slug, the Active chip and the checkout path', async () => {
    const load = vi.fn(async (): Promise<RepoListOutcome> => ({ ok: true, repos: [REPO] }));
    render(<RepoList load={load} />);

    expect(await screen.findByText('on-par/software-factory')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(screen.getByText('/tmp/software-factory')).toBeDefined();
  });

  it('renders "No repositories attached yet." for an empty registry', async () => {
    const load = vi.fn(async (): Promise<RepoListOutcome> => ({ ok: true, repos: [] }));
    render(<RepoList load={load} />);

    expect(await screen.findByText('No repositories attached yet.')).toBeDefined();
  });

  it('renders the role="alert" unavailable block with factoryd\'s message verbatim', async () => {
    const load = vi.fn(async (): Promise<RepoListOutcome> => ({ ok: false, error: 'connection refused' }));
    render(<RepoList load={load} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Repository list unavailable');
    expect(alert.textContent).toContain('connection refused');
  });

  it('AC 1: bumping refreshKey re-invokes load and the newly attached repo appears as active', async () => {
    const load = vi
      .fn<() => Promise<RepoListOutcome>>()
      .mockResolvedValueOnce({ ok: true, repos: [] })
      .mockResolvedValueOnce({ ok: true, repos: [REPO] });
    const { rerender } = render(<RepoList load={load} refreshKey={0} />);

    await screen.findByText('No repositories attached yet.');

    rerender(<RepoList load={load} refreshKey={1} />);

    expect(await screen.findByText('on-par/software-factory')).toBeDefined();
    expect(screen.getByText('Active')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('a refreshKey that does not change does not re-invoke load', async () => {
    const load = vi.fn(async (): Promise<RepoListOutcome> => ({ ok: true, repos: [] }));
    const { rerender } = render(<RepoList load={load} refreshKey={0} />);
    await screen.findByText('No repositories attached yet.');

    rerender(<RepoList load={load} refreshKey={0} />);

    expect(load).toHaveBeenCalledTimes(1);
  });
});
