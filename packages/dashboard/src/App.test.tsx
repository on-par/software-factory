// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App.js';

describe('App', () => {
  it('renders the Factory Dashboard heading', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { name: 'Factory Dashboard' }),
    ).toBeDefined();
  });

  it('applies Tailwind utility classes to the page shell', () => {
    const { container } = render(<App />);
    expect(container.firstElementChild?.className).toContain('min-h-screen');
  });
});
