import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf-8');
const themeBlockMatch = css.match(/@theme\s*\{([\s\S]*?)\n\}/);
const themeBlock = themeBlockMatch?.[1] ?? '';
const themeDeclarations = themeBlock.replace(/\/\*[\s\S]*?\*\//g, '');

describe('design tokens (index.css @theme)', () => {
  it('declares an @theme block that resets Tailwind defaults', () => {
    expect(themeBlockMatch).not.toBeNull();
    expect(themeBlock).toMatch(/--color-\*:\s*initial/);
  });

  it('resolves the building status token to teal', () => {
    expect(themeBlock).toMatch(/--color-status-building:\s*#14b8a6/);
  });

  it('never uses green, emerald, or lime anywhere in the theme declarations', () => {
    expect(themeDeclarations).not.toMatch(/green|emerald|lime/i);
  });

  it('declares Inter with a system sans fallback and a mono token', () => {
    expect(themeBlock).toMatch(/--font-sans:\s*"Inter",[^;]*system-ui/);
    expect(themeBlock).toMatch(/--font-mono:\s*[^;]+;/);
  });

  it('declares an 8px spacing grid', () => {
    expect(themeBlock).toMatch(/--spacing:\s*8px/);
  });

  it('declares a hairline border token', () => {
    expect(themeBlock).toMatch(/--color-hairline:\s*#[0-9a-f]{6}/i);
  });
});
