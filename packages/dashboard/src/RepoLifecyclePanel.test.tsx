// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RepoLifecyclePanel } from './RepoLifecyclePanel.js';
import type { RepoListing, RepoListResult, RepoMutationResult, RepoRegistryClient } from './repoRegistry.js';

afterEach(cleanup);

const ACTIVE: RepoListing = {
  slug: 'owner/app',
  path: '/repos/app',
  attachedAt: '2026-01-01T00:00:00Z',
  state: 'active',
};
const PAUSED: RepoListing = { ...ACTIVE, state: 'paused' };
const DRAINING: RepoListing = { ...ACTIVE, state: 'draining' };
const DETACHED: RepoListing = { ...ACTIVE, state: 'detached' };

interface FakeClient extends RepoRegistryClient {
  calls: string[];
}

function fakeClient(listQueue: RepoListing[][]): FakeClient {
  const calls: string[] = [];
  const queue = [...listQueue];
  return {
    calls,
    list: vi.fn(async (): Promise<RepoListResult> => {
      calls.push('list');
      const repos = queue.shift() ?? queue.at(-1) ?? [];
      return { ok: true, repos };
    }),
    pause: vi.fn(async (slug: string) => {
      calls.push(`pause:${slug}`);
      return { ok: true, repo: { ...ACTIVE, state: 'paused' } } satisfies RepoMutationResult;
    }),
    resume: vi.fn(async (slug: string) => {
      calls.push(`resume:${slug}`);
      return { ok: true, repo: { ...ACTIVE, state: 'active' } } satisfies RepoMutationResult;
    }),
    detach: vi.fn(async (slug: string) => {
      calls.push(`detach:${slug}`);
      return { ok: true, repo: { ...ACTIVE, state: 'draining' } } satisfies RepoMutationResult;
    }),
  };
}

describe('RepoLifecyclePanel', () => {
  it('renders a loading state before the first list resolves', () => {
    const client: RepoRegistryClient = {
      list: vi.fn(() => new Promise<RepoListResult>(() => {})),
      pause: vi.fn(),
      resume: vi.fn(),
      detach: vi.fn(),
    };
    render(<RepoLifecyclePanel client={client} />);
    expect(screen.getByText('Loading repos…')).toBeDefined();
  });

  it('renders an empty state for an empty registry', async () => {
    const client = fakeClient([[]]);
    render(<RepoLifecyclePanel client={client} />);
    await waitFor(() => expect(screen.getByText('No repos attached yet.')).toBeDefined());
  });

  it('renders one row per repo with the state chip and path', async () => {
    const client = fakeClient([[ACTIVE]]);
    render(<RepoLifecyclePanel client={client} />);
    const row = await screen.findByLabelText('Repo owner/app');
    expect(within(row).getByText('active')).toBeDefined();
    expect(within(row).getByText('/repos/app')).toBeDefined();
  });

  it('renders a load failure message and keeps no rows', async () => {
    const client: RepoRegistryClient = {
      list: vi.fn(async (): Promise<RepoListResult> => ({ ok: false, error: 'connection refused' })),
      pause: vi.fn(),
      resume: vi.fn(),
      detach: vi.fn(),
    };
    render(<RepoLifecyclePanel client={client} />);
    await waitFor(() => expect(screen.getByText('Could not read the repo registry: connection refused')).toBeDefined());
  });

  describe('pause', () => {
    it('shows Pause and no Resume on an active row, and pauses on click', async () => {
      const client = fakeClient([[ACTIVE], [PAUSED]]);
      render(<RepoLifecyclePanel client={client} />);
      const row = await screen.findByLabelText('Repo owner/app');
      expect(within(row).getByRole('button', { name: 'Pause' })).toBeDefined();
      expect(within(row).queryByRole('button', { name: 'Resume' })).toBeNull();

      fireEvent.click(within(row).getByRole('button', { name: 'Pause' }));

      await waitFor(() => expect(within(row).getByText('paused')).toBeDefined());
      expect(within(row).getByRole('button', { name: 'Resume' })).toBeDefined();
      expect(client.pause).toHaveBeenCalledWith('owner/app');
      expect(client.calls).toEqual(['list', 'pause:owner/app', 'list']);
    });
  });

  describe('resume', () => {
    it('shows Resume and no Pause on a paused row, and resumes on click', async () => {
      const client = fakeClient([[PAUSED], [ACTIVE]]);
      render(<RepoLifecyclePanel client={client} />);
      const row = await screen.findByLabelText('Repo owner/app');
      expect(within(row).getByRole('button', { name: 'Resume' })).toBeDefined();
      expect(within(row).queryByRole('button', { name: 'Pause' })).toBeNull();

      fireEvent.click(within(row).getByRole('button', { name: 'Resume' }));

      await waitFor(() => expect(within(row).getByText('active')).toBeDefined());
      expect(client.resume).toHaveBeenCalledWith('owner/app');
      expect(client.calls).toEqual(['list', 'resume:owner/app', 'list']);
    });
  });

  describe('detach', () => {
    it('detaching an active row shows the draining state with no buttons', async () => {
      const client = fakeClient([[ACTIVE], [DRAINING]]);
      render(<RepoLifecyclePanel client={client} />);
      const row = await screen.findByLabelText('Repo owner/app');

      fireEvent.click(within(row).getByRole('button', { name: 'Detach' }));

      await waitFor(() => expect(within(row).getByText('draining')).toBeDefined());
      expect(within(row).queryByRole('button')).toBeNull();
      expect(client.calls).toEqual(['list', 'detach:owner/app', 'list']);
    });

    it('detaching and landing on a detached tombstone renders no buttons', async () => {
      const client = fakeClient([[PAUSED], [DETACHED]]);
      render(<RepoLifecyclePanel client={client} />);
      const row = await screen.findByLabelText('Repo owner/app');

      fireEvent.click(within(row).getByRole('button', { name: 'Detach' }));

      await waitFor(() => expect(within(row).getByText('detached')).toBeDefined());
      expect(within(row).queryByRole('button')).toBeNull();
    });
  });

  it('renders a mutation failure message and leaves the row unchanged', async () => {
    const client: RepoRegistryClient = {
      list: vi.fn(async (): Promise<RepoListResult> => ({ ok: true, repos: [ACTIVE] })),
      pause: vi.fn(async (): Promise<RepoMutationResult> => ({ ok: false, error: 'registry locked' })),
      resume: vi.fn(),
      detach: vi.fn(),
    };
    render(<RepoLifecyclePanel client={client} />);
    const row = await screen.findByLabelText('Repo owner/app');
    fireEvent.click(within(row).getByRole('button', { name: 'Pause' }));

    await waitFor(() => expect(screen.getByText('pause failed for owner/app: registry locked')).toBeDefined());
    expect(within(row).getByText('active')).toBeDefined();
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('disables buttons and marks the row busy while a mutation is in flight', async () => {
    let resolvePause: (value: RepoMutationResult) => void = () => {};
    const client: RepoRegistryClient = {
      list: vi.fn(async (): Promise<RepoListResult> => ({ ok: true, repos: [ACTIVE] })),
      pause: vi.fn(
        () =>
          new Promise<RepoMutationResult>((resolve) => {
            resolvePause = resolve;
          }),
      ),
      resume: vi.fn(),
      detach: vi.fn(),
    };
    render(<RepoLifecyclePanel client={client} />);
    const row = await screen.findByLabelText('Repo owner/app');
    const pauseButton = within(row).getByRole('button', { name: 'Pause' });
    const detachButton = within(row).getByRole('button', { name: 'Detach' });

    fireEvent.click(pauseButton);

    await waitFor(() => expect(row.getAttribute('aria-busy')).toBe('true'));
    expect(pauseButton.hasAttribute('disabled')).toBe(true);
    expect(detachButton.hasAttribute('disabled')).toBe(true);

    resolvePause({ ok: true, repo: PAUSED });

    await waitFor(() => expect(row.getAttribute('aria-busy')).toBe('false'));
  });
});
