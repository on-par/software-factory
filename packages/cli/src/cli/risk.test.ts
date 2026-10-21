import { describe, expect, it, vi } from 'vitest';

import { parsePrArg, RiskCommandError, runRiskCommand, type RiskCommandDeps } from './risk.js';

function makeDeps(overrides: Partial<RiskCommandDeps> = {}): RiskCommandDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    repo: 'o/r',
    listFiles: async () => ['src/auth/login.ts', 'README.md'],
    readFile: () => '{}',
    fileExists: () => true,
    log: (line) => lines.push(line),
    ...overrides,
    lines,
  };
}

async function failure(p: Promise<unknown>): Promise<RiskCommandError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RiskCommandError);
    return err as RiskCommandError;
  }
  throw new Error('expected rejection');
}

describe('factory risk', () => {
  it('prints tier high for a PR touching an auth path', async () => {
    const deps = makeDeps();
    const evaluation = await runRiskCommand('42', {}, deps);
    expect(evaluation.tier).toBe('high');
    expect(deps.lines[0]).toBe('PR #42: tier high');
  });

  it('lists every matched rule with its tier and paths', async () => {
    const deps = makeDeps();
    const evaluation = await runRiskCommand('42', {}, deps);
    expect(deps.lines).toContain('  - auth (high): src/auth/login.ts');
    expect(deps.lines).toContain('  - docs (low): README.md');
    expect(deps.lines).toContain('Policy: packaged defaults');
    expect(deps.lines.filter((l) => l.startsWith('  - '))).toHaveLength(evaluation.rules.length);
  });

  it('rejects an invalid or unknown PR with a non-zero exit and a clear message', async () => {
    for (const raw of ['abc', '0', '-3', '99999999999999999999']) {
      const listFiles = vi.fn(async () => []);
      const err = await failure(runRiskCommand(raw, {}, makeDeps({ listFiles })));
      expect(err.code).toBe(2);
      expect(err.message).toContain('invalid PR argument');
      expect(listFiles).not.toHaveBeenCalled();
    }
    const notFound = makeDeps({
      listFiles: async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      },
    });
    const err = await failure(runRiskCommand('7', {}, notFound));
    expect(err.code).toBe(1);
    expect(err.message).toBe('factory risk: PR #7 not found in o/r');
  });

  it('reports other GitHub errors', async () => {
    const deps = makeDeps({
      listFiles: async () => {
        throw new Error('boom');
      },
    });
    const err = await failure(runRiskCommand('7', {}, deps));
    expect(err.code).toBe(1);
    expect(err.message).toBe('factory risk: could not list files for PR #7 — boom');
  });

  it('accepts #N', () => {
    expect(parsePrArg('#42')).toBe(42);
  });

  it('reports a missing policy file', async () => {
    const err = await failure(runRiskCommand('1', { policy: 'nope.json' }, makeDeps({ fileExists: () => false })));
    expect(err.code).toBe(2);
    expect(err.message).toBe('factory risk: risk policy file not found: nope.json');
  });

  it('reports an invalid policy file', async () => {
    const contents = ['not json', '{ "rules": [{ "id": "X", "tier": "high", "globs": ["a"] }] }'];
    for (const content of contents) {
      const err = await failure(runRiskCommand('1', { policy: 'p.json' }, makeDeps({ readFile: () => content })));
      expect(err.code).toBe(2);
      expect(err.message).toMatch(/^factory risk: invalid risk policy p\.json/);
    }
  });

  it('uses a custom policy', async () => {
    const policy = JSON.stringify({ rules: [{ id: 'all', tier: 'low', globs: ['**'] }] });
    const deps = makeDeps({ readFile: () => policy });
    const evaluation = await runRiskCommand('1', { policy: 'p.json' }, deps);
    expect(evaluation.tier).toBe('low');
    expect(deps.lines).toContain('Policy: p.json');
  });

  it('prints the empty-diff rule', async () => {
    const deps = makeDeps({ listFiles: async () => [] });
    await runRiskCommand('1', {}, deps);
    expect(deps.lines).toContain('  - empty-diff (med): (no changed files)');
  });
});
