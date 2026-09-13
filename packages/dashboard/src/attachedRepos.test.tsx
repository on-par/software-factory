// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  activeRepoSlugs,
  DEFAULT_REPOS_URL,
  fetchAttachedRepos,
  mergeAttachedRepos,
  useAttachedRepos,
} from './attachedRepos.js';

afterEach(cleanup);

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('activeRepoSlugs', () => {
  it('keeps only active entries, in registry order', () => {
    expect(
      activeRepoSlugs([
        { slug: 'a/one', state: 'active' },
        { slug: 'a/two', state: 'paused' },
        { slug: 'a/three', state: 'active' },
        { slug: 'a/four', state: 'detached' },
      ]),
    ).toEqual(['a/one', 'a/three']);
  });

  it('returns an empty list for an empty registry', () => {
    expect(activeRepoSlugs([])).toEqual([]);
  });
});

describe('mergeAttachedRepos', () => {
  it('keeps configured slugs first, in configured order', () => {
    expect(mergeAttachedRepos(['a/one', 'a/two'], ['a/two', 'a/one'])).toEqual(['a/one', 'a/two']);
  });

  it('appends a fetched slug missing from the configured list', () => {
    expect(mergeAttachedRepos(['a/one'], ['a/one', 'a/newly-attached'])).toEqual(['a/one', 'a/newly-attached']);
  });

  it('is the identity when nothing was fetched (e.g. factoryd unreachable)', () => {
    expect(mergeAttachedRepos(['a/one', 'a/two'], [])).toEqual(['a/one', 'a/two']);
  });

  it('handles no configured slugs at all', () => {
    expect(mergeAttachedRepos([], ['a/one', 'a/two'])).toEqual(['a/one', 'a/two']);
  });
});

describe('fetchAttachedRepos', () => {
  it('requests DEFAULT_REPOS_URL and returns the active slugs', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      fakeResponse(200, {
        repos: [
          { slug: 'a/one', state: 'active' },
          { slug: 'a/two', state: 'draining' },
        ],
      }),
    );

    const slugs = await fetchAttachedRepos({ fetch: fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(DEFAULT_REPOS_URL);
    expect(slugs).toEqual(['a/one']);
  });

  it('fails soft to an empty list on a non-OK response', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(500, { error: 'boom' }));
    expect(await fetchAttachedRepos({ fetch: fetchFn })).toEqual([]);
  });

  it('fails soft to an empty list when factoryd is unreachable', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await fetchAttachedRepos({ fetch: fetchFn })).toEqual([]);
  });

  it('fails soft to an empty list when the body has no repos array', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(200, {}));
    expect(await fetchAttachedRepos({ fetch: fetchFn })).toEqual([]);
  });
});

function Probe({ configured, fetchFn }: { configured: string[]; fetchFn: typeof globalThis.fetch }) {
  const repos = useAttachedRepos(configured, { fetch: fetchFn });
  return <span data-testid="repos">{repos.join(',')}</span>;
}

describe('useAttachedRepos', () => {
  it('renders the configured slugs immediately, before the fetch settles', () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    render(<Probe configured={['a/one']} fetchFn={fetchFn} />);

    expect(screen.getByTestId('repos').textContent).toBe('a/one');
  });

  it('merges in a repo attached at runtime once the fetch resolves (#1403)', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () =>
      fakeResponse(200, {
        repos: [
          { slug: 'a/one', state: 'active' },
          { slug: 'a/reattached', state: 'active' },
        ],
      }),
    );
    render(<Probe configured={['a/one']} fetchFn={fetchFn} />);

    await waitFor(() => expect(screen.getByTestId('repos').textContent).toBe('a/one,a/reattached'));
  });

  it('falls back to just the configured list when factoryd is unreachable', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('ECONNREFUSED');
    });
    render(<Probe configured={['a/one']} fetchFn={fetchFn} />);

    await act(() => Promise.resolve());
    expect(screen.getByTestId('repos').textContent).toBe('a/one');
  });

  it('fetches exactly once even if the component re-renders', async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>(async () => fakeResponse(200, { repos: [] }));
    const { rerender } = render(<Probe configured={['a/one']} fetchFn={fetchFn} />);
    rerender(<Probe configured={['a/one']} fetchFn={fetchFn} />);

    await act(() => Promise.resolve());
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
