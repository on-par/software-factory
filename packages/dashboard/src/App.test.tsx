// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { USAGE_UNAVAILABLE_REASON } from './usageHeadroomState.js';

afterEach(cleanup);

function reposResponse(repos: unknown[]): Response {
  return new Response(JSON.stringify({ repos }), { status: 200 });
}

describe('App', () => {
  it('renders the On Par Factory heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'On Par Factory' })).toBeDefined();
  });

  it('applies Tailwind utility classes to the page shell', () => {
    const { container } = render(<App />);
    expect(container.firstElementChild?.className).toContain('h-screen');
    expect(container.firstElementChild?.className).toContain('bg-canvas');
  });

  it('renders the primary navigation, header, and main content regions', () => {
    render(<App />);
    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeDefined();
    expect(screen.getByRole('banner')).toBeDefined();
    expect(screen.getByRole('main')).toBeDefined();
  });

  it('renders the lane status board, waiting for events in jsdom', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Lane status board' })).toBeDefined();
    expect(screen.getByText('Waiting for lane events…')).toBeDefined();
  });

  it('renders the placeholder nav links', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'Runs' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Issues' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Models' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeDefined();
  });

  it('applies the navy sidebar and light canvas classes', () => {
    render(<App />);
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav.closest('aside')?.className).toContain('bg-navy-950');
    expect(screen.getByRole('main').className).toContain('bg-canvas');
  });

  it('renders the KPI trend view in the main content', () => {
    render(<App />);
    expect(screen.getByText('KPI trends')).toBeDefined();
    expect(screen.getByText('No KPI history yet.')).toBeDefined();
  });

  it('renders the attach-a-repository form', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Attach a repository' })).toBeDefined();
  });

  it('renders the attached repositories region alongside the attach form', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Attached repositories' })).toBeDefined();
  });

  it('renders the Settings region and its nav link still resolves', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Settings' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeDefined();
  });

  it('renders the Usage headroom region in the unavailable state', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Usage headroom' })).toBeDefined();
    expect(screen.getByText(USAGE_UNAVAILABLE_REASON)).toBeDefined();
  });

  it('refreshes the attached repository list after a successful attach', async () => {
    let attached = false;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === '/repos' && init?.method === 'POST') {
        attached = true;
        return new Response(null, { status: 201 });
      }
      if (url === '/repos') {
        return reposResponse(
          attached
            ? [
                {
                  slug: 'on-par/software-factory',
                  path: '/tmp/software-factory',
                  attachedAt: '2026-01-01T00:00:00.000Z',
                  state: 'active',
                },
              ]
            : [],
        );
      }
      if (url === '/repos/on-par/software-factory/policy') {
        return new Response(
          JSON.stringify({ repo: 'on-par/software-factory', configPath: '/tmp/.factory/config.json', fields: [] }),
          {
            status: 200,
          },
        );
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchFn);

    try {
      render(<App />);
      await screen.findByText('No repositories attached yet.');

      fireEvent.change(screen.getByLabelText('GitHub repo (owner/name)'), {
        target: { value: 'on-par/software-factory' },
      });
      fireEvent.change(screen.getByLabelText('Local checkout path'), { target: { value: '/tmp/software-factory' } });
      fireEvent.click(screen.getByRole('button', { name: 'Attach repo' }));

      expect(await screen.findByText('Attached on-par/software-factory.')).toBeDefined();
      await waitFor(() => expect(screen.getByText('/tmp/software-factory')).toBeDefined());
      expect(fetchFn).toHaveBeenCalledWith('/repos', expect.objectContaining({ method: 'POST' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('App with ?repo= in the URL', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('renders the repo detail region instead of the fleet board', () => {
    window.history.replaceState({}, '', '?repo=a/one');
    render(<App />);

    expect(screen.getByRole('region', { name: 'Repo detail a/one' })).toBeDefined();
    expect(screen.queryByRole('region', { name: 'Lane status board' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Usage headroom' })).toBeNull();
  });

  it('still renders the fleet board with no query string', () => {
    render(<App />);
    expect(screen.getByRole('region', { name: 'Lane status board' })).toBeDefined();
  });
});
