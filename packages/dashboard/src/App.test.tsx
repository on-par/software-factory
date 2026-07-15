// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from './App.js';

afterEach(cleanup);

describe('App', () => {
  it('renders the On Par Factory heading', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'On Par Factory' }),
    ).toBeDefined();
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
});
