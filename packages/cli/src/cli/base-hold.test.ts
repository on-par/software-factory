import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

import {
  BASE_HOLD_CI_RECHECK_MS,
  type BaseHold,
  createBaseHoldGate,
  deleteBaseHold,
  evaluateBaseHold,
  formatBaseHoldStatus,
  parseLsRemoteSha,
  readBaseHold,
  writeBaseHold,
} from './base-hold.js';

const hold: BaseHold = {
  repo: 'on-par/software-factory',
  baseSha: 'abc1234567890def',
  failingChecks: ['tests', 'lint'],
  since: '2026-01-01T00:00:00.000Z',
};

describe('base-hold', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-base-hold-'));
    file = join(dir, 'state', 'base-hold.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the hold under a missing state dir', () => {
    writeBaseHold(file, hold);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual(hold);
  });

  it('reads back exactly the record that was written', () => {
    writeBaseHold(file, hold);
    const read = readBaseHold(file);
    expect(read).toEqual(hold);
    expect(read?.failingChecks).not.toBe(hold.failingChecks);
  });

  it('drops unknown keys', async () => {
    await mkdir(join(dir, 'state'), { recursive: true });
    await writeFile(file, JSON.stringify({ ...hold, extra: 1 }));
    expect(readBaseHold(file)).toEqual(hold);
  });

  it.each([
    ['missing file', undefined],
    ['non-JSON', 'not json'],
    ['null', 'null'],
    ['array', '[]'],
    ['number', '42'],
    ['empty object', '{}'],
    ['repo not a string', JSON.stringify({ ...hold, repo: 1 })],
    ['baseSha not a string', JSON.stringify({ ...hold, baseSha: 1 })],
    ['since not a string', JSON.stringify({ ...hold, since: 1 })],
    ['failingChecks not an array', JSON.stringify({ ...hold, failingChecks: 'tests' })],
    ['failingChecks containing a number', JSON.stringify({ ...hold, failingChecks: ['tests', 1] })],
  ])('treats a missing or malformed file as no hold (%s)', async (_name, content) => {
    if (content !== undefined) {
      await mkdir(join(dir, 'state'), { recursive: true });
      await writeFile(file, content);
    }
    expect(() => readBaseHold(file)).not.toThrow();
    expect(readBaseHold(file)).toBeNull();
  });

  it('deletes the hold, and deleting an absent hold is a no-op', () => {
    writeBaseHold(file, hold);
    deleteBaseHold(file);
    expect(existsSync(file)).toBe(false);
    expect(readBaseHold(file)).toBeNull();
    expect(() => deleteBaseHold(file)).not.toThrow();
  });
});

describe('formatBaseHoldStatus (#2351)', () => {
  it('lists repo, full baseSha, failing checks and since', () => {
    expect(formatBaseHoldStatus(hold)).toEqual([
      '  repo: on-par/software-factory',
      '  baseSha: abc1234567890def',
      '  failingChecks: tests, lint',
      '  since: 2026-01-01T00:00:00.000Z',
    ]);
  });

  it('renders (none recorded) when no checks failed', () => {
    expect(formatBaseHoldStatus({ ...hold, failingChecks: [] })).toContain('  failingChecks: (none recorded)');
  });
});

const SHA_HELD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);
const gateHold: BaseHold = { ...hold, baseSha: SHA_HELD };

describe('base hold gate (#2349)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-base-hold-gate-'));
    file = join(dir, 'state', 'base-hold.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('evaluateBaseHold', () => {
    const mkDeps = (sha: string | null | Error = SHA_HELD, green: boolean | Error = false) => ({
      currentBaseSha: vi.fn(async () => {
        if (sha instanceof Error) throw sha;
        return sha;
      }),
      requiredChecksVerdict: vi.fn(async () => {
        if (green instanceof Error) throw green;
        return { green, reason: green ? 'ok' : 'ci failure' };
      }),
    });

    it('claims with no hold file and calls no dep', async () => {
      const deps = mkDeps();
      expect(await evaluateBaseHold(file, hold.repo, deps)).toEqual({ kind: 'claim' });
      expect(deps.currentBaseSha).toHaveBeenCalledTimes(0);
      expect(deps.requiredChecksVerdict).toHaveBeenCalledTimes(0);
    });

    it('claims for a hold on another repo and calls no dep', async () => {
      writeBaseHold(file, gateHold);
      const deps = mkDeps();
      expect(await evaluateBaseHold(file, 'other/repo', deps)).toEqual({ kind: 'claim' });
      expect(deps.currentBaseSha).toHaveBeenCalledTimes(0);
      expect(deps.requiredChecksVerdict).toHaveBeenCalledTimes(0);
    });

    it('holds on the same SHA with CI not green', async () => {
      writeBaseHold(file, gateHold);
      expect(await evaluateBaseHold(file, hold.repo, mkDeps())).toEqual({
        kind: 'hold',
        hold: gateHold,
        ciReason: 'ci failure',
      });
    });

    it('claims when the current SHA is null or the lookup throws', async () => {
      writeBaseHold(file, gateHold);
      expect(await evaluateBaseHold(file, hold.repo, mkDeps(null))).toEqual({ kind: 'claim' });
      expect(await evaluateBaseHold(file, hold.repo, mkDeps(new Error('offline')))).toEqual({ kind: 'claim' });
    });

    it('holds when the CI lookup throws', async () => {
      writeBaseHold(file, gateHold);
      expect(await evaluateBaseHold(file, hold.repo, mkDeps(SHA_HELD, new Error('api')))).toEqual({
        kind: 'hold',
        hold: gateHold,
        ciReason: expect.stringContaining('CI lookup failed'),
      });
    });
  });

  describe('parseLsRemoteSha', () => {
    it('parses a valid ls-remote line', () => {
      expect(parseLsRemoteSha(`${SHA_HELD}\trefs/heads/main\n`)).toBe(SHA_HELD);
    });

    it('returns null for empty or garbage output', () => {
      expect(parseLsRemoteSha('')).toBeNull();
      expect(parseLsRemoteSha('\n\n')).toBeNull();
      expect(parseLsRemoteSha('fatal: not a repo')).toBeNull();
    });
  });

  describe('createBaseHoldGate', () => {
    it('claims when origin/main moved off the held SHA', async () => {
      writeBaseHold(file, gateHold);
      const requiredChecksVerdict = vi.fn(async () => ({ green: false, reason: 'x' }));
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git: async () => `${SHA_NEW}\trefs/heads/main\n`,
        requiredChecksVerdict,
      });
      expect(await gate()).toEqual({ kind: 'claim' });
      expect(existsSync(file)).toBe(false);
      expect(requiredChecksVerdict).toHaveBeenCalledTimes(0);
    });

    it('claims when the held SHA is unchanged but its CI is green', async () => {
      writeBaseHold(file, gateHold);
      const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git: async () => `${SHA_HELD}\trefs/heads/main\n`,
        requiredChecksVerdict,
      });
      expect(await gate()).toEqual({ kind: 'claim' });
      expect(requiredChecksVerdict).toHaveBeenCalledWith(SHA_HELD);
      expect(existsSync(file)).toBe(false);
    });

    it('holds when the held SHA is unchanged and CI is failing', async () => {
      writeBaseHold(file, gateHold);
      const git = vi.fn(async () => `${SHA_HELD}\trefs/heads/main\n`);
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git,
        requiredChecksVerdict: async () => ({ green: false, reason: 'ci failure' }),
      });
      expect(await gate()).toEqual({ kind: 'hold', hold: gateHold, ciReason: 'ci failure' });
      expect(git).toHaveBeenCalledWith('git ls-remote origin refs/heads/main');
    });
  });
});

describe('ci-awaiting base hold (#3186)', () => {
  const SHA = 'a'.repeat(40);
  const T0 = Date.parse('2026-02-01T00:00:00.000Z');
  const recheck = new Date(T0 + 1000).toISOString();
  const tempDirs = createTempDirs();
  let dir: string;
  let file: string;
  const awaiting: BaseHold = { ...hold, baseSha: SHA, ciRecheckAfter: recheck };

  beforeEach(async () => {
    dir = await tempDirs.make('factory-base-hold-ci-');
    file = join(dir, 'state', 'base-hold.json');
  });
  afterEach(async () => {
    await tempDirs.cleanup();
  });

  const deps = (extra: Partial<Parameters<typeof evaluateBaseHold>[2]>) => ({
    currentBaseSha: async () => SHA,
    ...extra,
  });

  it('round-trips ciRecheckAfter and drops a malformed value', () => {
    writeBaseHold(file, awaiting);
    expect(readBaseHold(file)).toEqual(awaiting);
    writeFileSync(file, JSON.stringify({ ...awaiting, ciRecheckAfter: 'not a date' }));
    expect(readBaseHold(file)).toEqual({ ...hold, baseSha: SHA });
    writeFileSync(file, JSON.stringify({ ...awaiting, ciRecheckAfter: 5 }));
    expect(readBaseHold(file)?.ciRecheckAfter).toBeUndefined();
  });

  it('holds without any CI lookup before ciRecheckAfter', async () => {
    writeBaseHold(file, awaiting);
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    const d = deps({ requiredChecksVerdict, now: () => T0 });
    expect(await evaluateBaseHold(file, hold.repo, d)).toEqual({ kind: 'hold', hold: awaiting });
    expect(requiredChecksVerdict).not.toHaveBeenCalled();
  });

  it.each([
    ['not green', async () => ({ green: false, reason: 'x skipped' })],
    [
      'a throw',
      async (): Promise<{ green: boolean; reason: string }> => {
        throw new Error('offline');
      },
    ],
    ['an absent dep', undefined],
  ])('after the time, %s re-arms the backoff', async (_n, requiredChecksVerdict) => {
    writeBaseHold(file, awaiting);
    const now = T0 + 2000;
    const d = deps({ requiredChecksVerdict, now: () => now });
    expect((await evaluateBaseHold(file, hold.repo, d)).kind).toBe('hold');
    expect(readBaseHold(file)?.ciRecheckAfter).toBe(new Date(now + BASE_HOLD_CI_RECHECK_MS).toISOString());
  });

  it('after the time, a green strict verdict clears with ci-green', async () => {
    writeBaseHold(file, awaiting);
    const onCleared = vi.fn();
    const d = deps({
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      now: () => T0 + 2000,
      onCleared,
    });
    expect(await evaluateBaseHold(file, hold.repo, d)).toEqual({ kind: 'claim' });
    expect(onCleared).toHaveBeenCalledWith({ hold: awaiting, reason: 'ci-green', currentSha: SHA });
    expect(existsSync(file)).toBe(false);
  });

  it('a moved SHA clears with sha-changed before any backoff', async () => {
    writeBaseHold(file, awaiting);
    const onCleared = vi.fn();
    const d = deps({ currentBaseSha: async () => 'c'.repeat(40), now: () => T0, onCleared });
    expect(await evaluateBaseHold(file, hold.repo, d)).toEqual({ kind: 'claim' });
    expect(onCleared.mock.calls[0][0].reason).toBe('sha-changed');
  });

  it('a hold without the field is judged by the same strict verdict, without backoff', async () => {
    writeBaseHold(file, { ...hold, baseSha: SHA });
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    const d = deps({ requiredChecksVerdict });
    expect(await evaluateBaseHold(file, hold.repo, d)).toEqual({ kind: 'claim' });
    expect(requiredChecksVerdict).toHaveBeenCalledWith(SHA);
  });

  it('createBaseHoldGate forwards requiredChecksVerdict and now', async () => {
    writeBaseHold(file, awaiting);
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'ok' }));
    const gate = createBaseHoldGate({
      file,
      repo: hold.repo,
      git: async () => `${SHA}\trefs/heads/main\n`,
      requiredChecksVerdict,
      now: () => T0 + 2000,
    });
    expect(await gate()).toEqual({ kind: 'claim' });
    expect(requiredChecksVerdict).toHaveBeenCalledWith(SHA);
  });
});

describe('base hold gate (#3195)', () => {
  const SHA = '8fdcb345'.padEnd(40, '0');
  const tempDirs = createTempDirs();
  let file: string;
  const testsHold: BaseHold = { ...hold, baseSha: SHA, failingChecks: ['tests'] };
  const ok = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
  const baseRuns = [
    ok('ci'),
    ok('gitleaks'),
    ok('publish'),
    { name: 'pipeline-integration', status: 'completed', conclusion: 'failure' },
  ];

  beforeEach(async () => {
    file = join(await tempDirs.make('factory-base-hold-3195-'), 'state', 'base-hold.json');
    writeBaseHold(file, testsHold);
  });
  afterEach(async () => {
    await tempDirs.cleanup();
  });

  // Mirrors core's evaluateRequiredChecks(['ci'], runs): internal.ts is at its max-lines ceiling, so it is not re-exported.
  const evaluateRequiredChecks = (
    required: string[],
    runs: Array<{ name: string; status: string; conclusion: string | null }>,
  ) => {
    const run = runs.find((r) => r.name === required[0]);
    const green = run?.status === 'completed' && run.conclusion === 'success';
    return {
      green,
      reason: green ? 'ok' : `${required[0]} ${run?.conclusion ?? 'missing'}`,
      basis: `required checks: ${required[0]}`,
    };
  };

  const gateFor = (runs: Array<{ name: string; status: string; conclusion: string | null }>, onCleared?: () => void) =>
    createBaseHoldGate({
      file,
      repo: hold.repo,
      git: async () => `${SHA}\trefs/heads/main\n`,
      requiredChecksVerdict: async () => evaluateRequiredChecks(['ci'], runs),
      onCleared,
    });

  it('clears a tests hold on 8fdcb345 when required ci is green despite a failed scheduled pipeline-integration', async () => {
    const onCleared = vi.fn();
    expect(await gateFor(baseRuns, onCleared)()).toEqual({ kind: 'claim' });
    expect(onCleared).toHaveBeenCalledWith({
      hold: testsHold,
      reason: 'ci-green',
      currentSha: SHA,
      basis: 'required checks: ci',
    });
    expect(existsSync(file)).toBe(false);
  });

  it('stays held with ciReason naming ci when ci failed and scheduled runs are green', async () => {
    const runs = baseRuns.map((r) => ({ ...r, conclusion: r.name === 'ci' ? 'failure' : 'success' }));
    expect(await gateFor(runs)()).toEqual({ kind: 'hold', hold: testsHold, ciReason: 'ci failure' });
    expect(existsSync(file)).toBe(true);
  });

  it.each([
    ['in_progress', [{ name: 'ci', status: 'in_progress', conclusion: null }]],
    ['skipped', [{ name: 'ci', status: 'completed', conclusion: 'skipped' }]],
    ['missing', [ok('gitleaks')]],
  ])('stays held for ci %s', async (_n, runs) => {
    expect((await gateFor(runs)()).kind).toBe('hold');
    expect(existsSync(file)).toBe(true);
  });

  it('stays held with a CI lookup failure reason when the lookup throws', async () => {
    const gate = createBaseHoldGate({
      file,
      repo: hold.repo,
      git: async () => `${SHA}\trefs/heads/main\n`,
      requiredChecksVerdict: async () => {
        throw new Error('401');
      },
    });
    expect(await gate()).toEqual({ kind: 'hold', hold: testsHold, ciReason: 'CI lookup failed: 401' });
  });
});
