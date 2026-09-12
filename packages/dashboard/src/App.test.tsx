// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App.js';
import { USAGE_UNAVAILABLE_REASON } from './usageHeadroomState.js';

afterEach(cleanup);

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
