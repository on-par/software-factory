// packages/product/src/cli/program.test.ts (#469).

import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, defaultDeps, getProductVersion, main, type ProgramDeps } from './program.js';

function stubDeps(overrides: Partial<ProgramDeps> = {}): ProgramDeps {
  return {
    repoRoot: '/repo',
    listAdrs: vi.fn(() => []),
    write: vi.fn(),
    ...overrides,
  };
}

describe('getProductVersion', () => {
  it('reads the version from package.json', () => {
    expect(getProductVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('buildProgram', () => {
  it('names the program product and lists the adr command in help', () => {
    const program = buildProgram(stubDeps());
    expect(program.name()).toBe('product');
    const help = program.helpInformation();
    expect(help).toContain('Usage: product');
    expect(help).toContain('adr');
  });
});

describe('main', () => {
  it('prints the ADR home for `adr home`', async () => {
    const deps = stubDeps();
    await main(['node', 'product', 'adr', 'home'], deps);
    expect(deps.write).toHaveBeenCalledWith(resolve('/repo/docs/adr'));
  });

  it('prints the next ADR filename for `adr next <title>`', async () => {
    const listAdrs = vi.fn(() => ['0001-a.md', '0002-b.md']);
    const deps = stubDeps({ listAdrs });
    await main(['node', 'product', 'adr', 'next', 'A Big Choice'], deps);
    expect(listAdrs).toHaveBeenCalledWith(resolve('/repo/docs/adr'));
    expect(deps.write).toHaveBeenCalledWith('0003-a-big-choice.md');
  });
});

describe('defaultDeps', () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the repo root from process.cwd()', () => {
    expect(defaultDeps().repoRoot).toBe(originalCwd);
  });

  it('writes via console.log', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    defaultDeps().write('hello');
    expect(spy).toHaveBeenCalledWith('hello');
  });

  it('lists ADRs from the real docs/adr/ directory', () => {
    const result = defaultDeps().listAdrs(resolve(originalCwd, 'docs/adr'));
    expect(Array.isArray(result)).toBe(true);
  });
});
