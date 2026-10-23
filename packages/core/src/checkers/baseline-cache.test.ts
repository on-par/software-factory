import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelRouter } from '../router/index.js';
import type { CommandResult } from '../utils/command-runner.js';

import type { CheckerOutput, Constitution } from '../types/index.js';
import { BaselineCache, hashBaselineCheckerConfig, hashBaselineEnv } from './baseline-cache.js';
import { runBaselineCheckers } from './baseline.js';
import { schemaErrorCheckerOutput, unfilledPlaceholderCheckerOutput, unknownCheckerOutput } from './index.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempDirs].map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.clear();
});

async function cacheFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'baseline-cache-'));
  tempDirs.add(dir);
  return join(dir, 'state', 'baseline-cache.json');
}

const out = (checker: string, result: CheckerOutput['result'], details = ''): CheckerOutput => ({
  checker,
  result,
  details,
});

describe('hashBaselineEnv', () => {
  it('is stable across key order', () => {
    expect(hashBaselineEnv({ A: '1', B: '2' })).toBe(hashBaselineEnv({ B: '2', A: '1' }));
  });

  it('ignores per-lane and per-run keys', () => {
    const base = { FACTORY_HEADLESS: '1' };
    expect(
      hashBaselineEnv({
        ...base,
        PORT: '4001',
        FACTORY_APP_PORT: '4001',
        FACTORY_BASE_URL: 'http://127.0.0.1:4001',
        SharedCompilationId: 'factory-run1',
      }),
    ).toBe(hashBaselineEnv(base));
  });

  it('changes when a key is added, removed or changed', () => {
    const withKey = hashBaselineEnv({ FACTORY_HEADLESS: '1' });
    expect(withKey).not.toBe(hashBaselineEnv({}));
    expect(withKey).not.toBe(hashBaselineEnv({ FACTORY_HEADLESS: '0' }));
  });

  it('treats undefined like an empty env', () => {
    expect(hashBaselineEnv(undefined)).toBe(hashBaselineEnv({}));
    expect(hashBaselineEnv({})).toMatch(/^[0-9a-f]{16}$/);
  });
});

const constitution = (extra: Partial<Constitution> = {}): Constitution => ({
  product: 'p',
  version: 1,
  checkers: ['tests'],
  body: '',
  path: 'c.md',
  source: 'repo',
  ...extra,
});

describe('hashBaselineCheckerConfig', () => {
  it('is stable for equal configs and ignores body and path', () => {
    expect(hashBaselineCheckerConfig(constitution())).toBe(
      hashBaselineCheckerConfig(constitution({ body: 'other', path: 'x.md' })),
    );
  });

  it('changes when checkers, requireTests or optionalCheckers change', () => {
    const base = hashBaselineCheckerConfig(constitution());
    expect(hashBaselineCheckerConfig(constitution({ checkers: ['tests', 'lint'] }))).not.toBe(base);
    expect(hashBaselineCheckerConfig(constitution({ requireTests: true }))).not.toBe(base);
    expect(hashBaselineCheckerConfig(constitution({ optionalCheckers: ['lint'] }))).not.toBe(base);
  });

  it('gives a 16-hex string for a null constitution', () => {
    expect(hashBaselineCheckerConfig(null)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('BaselineCache', () => {
  it('misses on a missing file', async () => {
    const cache = new BaselineCache(await cacheFile());
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('round-trips and writes a versioned file', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file, () => 0);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL', 'boom'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toEqual(out('tests', 'FAIL', 'boom'));
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toEqual(out('lint', 'PASS'));
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.entries['sha:env:tests'].recordedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('misses on a different envHash or baseSha', async () => {
    const cache = new BaselineCache(await cacheFile());
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'other', 'cfg', 'tests')).toBeUndefined();
    expect(await cache.get('other', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('does not store SKIP outputs and does not create the file for an all-SKIP set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'SKIP')]);
    expect(existsSync(file)).toBe(false);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'SKIP'), out('lint', 'PASS')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toBeDefined();
  });

  it('ignores entries whose stored output does not match', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    parsed.entries['sha:env:tests'].output.checker = 'lint';
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
    parsed.entries['sha:env:tests'].output = null;
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('treats malformed JSON as empty and repairs it on the next set', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('lint', 'PASS')]);
    await writeFile(file, '{not json');
    expect(await cache.get('sha', 'env', 'cfg', 'lint')).toBeUndefined();
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeDefined();
    await writeFile(file, JSON.stringify({ version: 1, entries: [] }));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });

  it('never stores or returns config-error outputs (#2563)', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    const bad = [
      unknownCheckerOutput('typecheck'),
      schemaErrorCheckerOutput('checkers', 'is a string, not a list'),
      unfilledPlaceholderCheckerOutput('<Standard Category 1>'),
    ];
    await cache.set('sha', 'env', 'cfg', bad);
    await expect(readFile(file, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    await cache.set('sha', 'env', 'cfg', [...bad, out('lint', 'PASS')]);
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    expect(Object.keys(parsed.entries)).toEqual(['sha:env:lint']);
    parsed.entries['sha:env:typecheck'] = {
      output: unknownCheckerOutput('typecheck'),
      configHash: 'cfg',
      recordedAt: '1970-01-01T00:00:00.000Z',
    };
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'typecheck')).toBeUndefined();
  });

  it('misses on a different or missing configHash', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('tests', 'FAIL')]);
    expect(await cache.get('sha', 'env', 'other', 'tests')).toBeUndefined();
    const parsed = JSON.parse(await readFile(file, 'utf-8'));
    delete parsed.entries['sha:env:tests'].configHash;
    await writeFile(file, JSON.stringify(parsed));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toBeUndefined();
  });
});

describe('BaselineCache timeouts (#3186)', () => {
  const timedOut: CheckerOutput = {
    checker: 'compile',
    result: 'FAIL',
    details: 'timed out after 120s',
    timedOut: true,
  };

  it('does not store a timed-out output but stores the others', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [timedOut]);
    expect(existsSync(file)).toBe(false);
    await cache.set('sha', 'env', 'cfg', [timedOut, out('lint', 'FAIL', 'x')]);
    expect(await cache.get('sha', 'env', 'cfg', 'compile')).toBeUndefined();
    expect((await cache.get('sha', 'env', 'cfg', 'lint'))?.details).toBe('x');
  });

  it('ignores a hand-written timed-out entry on read', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file);
    await cache.set('sha', 'env', 'cfg', [out('compile', 'FAIL', 'x')]);
    const data = JSON.parse(await readFile(file, 'utf-8'));
    data.entries['sha:env:compile'].output.timedOut = true;
    await writeFile(file, JSON.stringify(data));
    expect(await cache.get('sha', 'env', 'cfg', 'compile')).toBeUndefined();
  });

  it.each([
    ['compile', 'make failed: Command timed out after 120000 milliseconds: make'],
    ['compile', 'timed out after 120s'],
    ['compile', 'retry timed out after 1.25s while running'],
    ['tests', 'test command: timed out after 3s (limit)'],
  ])('ignores legacy timeout entries without a timedOut flag (%s: %s)', async (checker, details) => {
    const file = await cacheFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          [`sha:env:${checker}`]: {
            output: { checker, result: 'FAIL', details },
            configHash: 'cfg',
            recordedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const cache = new BaselineCache(file, () => Date.parse('2026-01-01T00:00:00.000Z'));
    expect(await cache.get('sha', 'env', 'cfg', checker)).toBeUndefined();
  });

  it.each([
    ['ordinary failure', { checker: 'tests', result: 'FAIL', details: 'assertion failed' }],
    ['empty details', { checker: 'tests', result: 'FAIL', details: '' }],
    ['near-match timeout wording', { checker: 'tests', result: 'FAIL', details: 'test named timeout failed' }],
    ['explicit false', { checker: 'tests', result: 'FAIL', details: 'timed out after 3s', timedOut: false }],
  ])('preserves ordinary failure entries (%s)', async (_label, output) => {
    const file = await cacheFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: {
          'sha:env:tests': { output, configHash: 'cfg', recordedAt: '2026-01-01T00:00:00.000Z' },
        },
      }),
    );
    const cache = new BaselineCache(file, () => Date.parse('2026-01-01T00:00:00.000Z'));
    expect(await cache.get('sha', 'env', 'cfg', 'tests')).toEqual(output);
  });

  it.each([undefined, null, 42, {}])(
    'safely reads legacy timeout entries with malformed details (%s)',
    async (details) => {
      const file = await cacheFile();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        JSON.stringify({
          version: 1,
          entries: {
            'sha:env:tests': {
              output: { checker: 'tests', result: 'PASS', details },
              configHash: 'cfg',
              recordedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        }),
      );
      const cache = new BaselineCache(file, () => Date.parse('2026-01-01T00:00:00.000Z'));
      await expect(cache.get('sha', 'env', 'cfg', 'tests')).resolves.toMatchObject({ result: 'PASS' });
    },
  );
});

const cmdOk = (): CommandResult => ({
  command: [],
  stdout: '',
  stderr: '',
  exitCode: 0,
  killed: false,
  timedOut: false,
  ok: true,
});

describe('BaselineCache TTL (#3540)', () => {
  const HOUR = 3_600_000;
  const T0 = Date.UTC(2026, 0, 1);
  const SHA = 'c'.repeat(40);
  const env = hashBaselineEnv({ A: '1' });
  const cfg = hashBaselineCheckerConfig(null);

  it('ignores an entry older than the default 24h TTL and runBaselineCheckers re-runs the checker', async () => {
    const file = await cacheFile();
    await new BaselineCache(file, () => T0).set(SHA, env, cfg, [out('tests', 'FAIL')]);
    const cache = new BaselineCache(file, () => T0 + 24 * HOUR + 1);
    expect(await cache.get(SHA, env, cfg, 'tests')).toBeUndefined();
    const dir = dirname(file);
    const runCheckers = vi.fn(async () => ({
      failures: 0,
      passes: 1,
      skips: 0,
      total: 1,
      results: [out('tests', 'PASS')],
    }));
    await runBaselineCheckers({
      baseSha: SHA,
      laneWorktree: dir,
      failing: [out('tests', 'FAIL')],
      ctx: { worktree: dir, specPath: '', env: { A: '1' } },
      router: {} as ModelRouter,
      constitution: null,
      cache,
      deps: {
        runCommand: vi.fn(async () => cmdOk()),
        runCheckers: runCheckers as never,
        makeTempDir: () => mkdtemp(join(dir, 'p-')),
      },
    });
    expect(runCheckers).toHaveBeenCalledTimes(1);
    expect((runCheckers.mock.calls[0] as unknown[])[4]).toEqual(['tests']);
  });

  it('reuses a PASS younger than the TTL without running checkers', async () => {
    const file = await cacheFile();
    await new BaselineCache(file, () => T0).set(SHA, env, cfg, [out('tests', 'PASS')]);
    const cache = new BaselineCache(file, () => T0 + 23 * HOUR);
    expect((await cache.get(SHA, env, cfg, 'tests'))?.result).toBe('PASS');
    const dir = dirname(file);
    const runCheckers = vi.fn();
    const runCommand = vi.fn(async () => cmdOk());
    const report = await runBaselineCheckers({
      baseSha: SHA,
      laneWorktree: dir,
      failing: [out('tests', 'FAIL')],
      ctx: { worktree: dir, specPath: '', env: { A: '1' } },
      router: {} as ModelRouter,
      constitution: null,
      cache,
      deps: { runCommand, runCheckers: runCheckers as never, makeTempDir: () => mkdtemp(join(dir, 'p-')) },
    });
    expect(runCheckers).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
    expect(report.checkers[0]).toMatchObject({ cached: true, verdict: 'clean-on-base' });
  });

  it('honours a custom ttlHours', async () => {
    const file = await cacheFile();
    await new BaselineCache(file, () => T0).set(SHA, env, cfg, [out('tests', 'PASS')]);
    expect(await new BaselineCache(file, () => T0 + 2 * HOUR, 1).get(SHA, env, cfg, 'tests')).toBeUndefined();
    expect(await new BaselineCache(file, () => T0 + 2 * HOUR, 3).get(SHA, env, cfg, 'tests')).toBeDefined();
  });

  it('treats an unparseable recordedAt as expired', async () => {
    const file = await cacheFile();
    await mkdir(dirname(file), { recursive: true });
    const entry = { output: out('tests', 'PASS'), configHash: cfg, recordedAt: 'not-a-date' };
    await writeFile(file, JSON.stringify({ version: 1, entries: { [`${SHA}:${env}:tests`]: entry } }));
    expect(await new BaselineCache(file, () => T0).get(SHA, env, cfg, 'tests')).toBeUndefined();
  });

  it('delete removes only that key, and returns false without creating the file when absent', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file, () => T0);
    expect(await cache.delete(SHA, env, 'tests')).toBe(false);
    expect(existsSync(file)).toBe(false);
    await cache.set(SHA, env, cfg, [out('tests', 'FAIL'), out('lint', 'PASS')]);
    expect(await cache.delete(SHA, env, 'tests')).toBe(true);
    expect(await cache.get(SHA, env, cfg, 'tests')).toBeUndefined();
    expect(await cache.get(SHA, env, cfg, 'lint')).toBeDefined();
  });

  it('clear removes all entries, or those whose SHA prefix matches (case-insensitive)', async () => {
    const file = await cacheFile();
    const cache = new BaselineCache(file, () => T0);
    const other = 'd'.repeat(40);
    await cache.set(SHA, env, cfg, [out('tests', 'FAIL'), out('lint', 'PASS')]);
    await cache.set(other, env, cfg, [out('tests', 'FAIL')]);
    expect(await cache.clear('CCCC')).toBe(2);
    expect(await cache.get(SHA, env, cfg, 'tests')).toBeUndefined();
    expect(await cache.get(other, env, cfg, 'tests')).toBeDefined();
    expect(await cache.clear('ffff')).toBe(0);
    expect(await cache.clear()).toBe(1);
    expect(await cache.clear()).toBe(0);
  });

  it('clear on a missing file returns 0 and creates nothing', async () => {
    const file = await cacheFile();
    expect(await new BaselineCache(file).clear()).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
