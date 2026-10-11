import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BaseHold,
  createBaseHoldGate,
  deleteBaseHold,
  evaluateBaseHold,
  formatBaseHoldStatus,
  isGreenCheckRunSet,
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
      baseCiGreen: vi.fn(async () => {
        if (green instanceof Error) throw green;
        return green;
      }),
    });

    it('claims with no hold file and calls no dep', async () => {
      const deps = mkDeps();
      expect(await evaluateBaseHold(file, hold.repo, deps)).toEqual({ kind: 'claim' });
      expect(deps.currentBaseSha).toHaveBeenCalledTimes(0);
      expect(deps.baseCiGreen).toHaveBeenCalledTimes(0);
    });

    it('claims for a hold on another repo and calls no dep', async () => {
      writeBaseHold(file, gateHold);
      const deps = mkDeps();
      expect(await evaluateBaseHold(file, 'other/repo', deps)).toEqual({ kind: 'claim' });
      expect(deps.currentBaseSha).toHaveBeenCalledTimes(0);
      expect(deps.baseCiGreen).toHaveBeenCalledTimes(0);
    });

    it('holds on the same SHA with CI not green', async () => {
      writeBaseHold(file, gateHold);
      expect(await evaluateBaseHold(file, hold.repo, mkDeps())).toEqual({ kind: 'hold', hold: gateHold });
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
      });
    });
  });

  describe('isGreenCheckRunSet', () => {
    it('is false for an empty set', () => {
      expect(isGreenCheckRunSet([])).toBe(false);
    });

    it('is false for a run that is not completed', () => {
      expect(isGreenCheckRunSet([{ status: 'in_progress', conclusion: null }])).toBe(false);
    });

    it.each(['failure', 'cancelled', null])('is false for conclusion %s', (conclusion) => {
      expect(isGreenCheckRunSet([{ status: 'completed', conclusion }])).toBe(false);
    });

    it('is true when every run completed with a passing conclusion', () => {
      expect(
        isGreenCheckRunSet([
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'neutral' },
          { status: 'completed', conclusion: 'skipped' },
        ]),
      ).toBe(true);
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
      const listCheckRuns = vi.fn(async () => []);
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git: async () => `${SHA_NEW}\trefs/heads/main\n`,
        listCheckRuns,
      });
      expect(await gate()).toEqual({ kind: 'claim' });
      expect(existsSync(file)).toBe(false);
      expect(listCheckRuns).toHaveBeenCalledTimes(0);
    });

    it('claims when the held SHA is unchanged but its CI is green', async () => {
      writeBaseHold(file, gateHold);
      const listCheckRuns = vi.fn(async () => [{ status: 'completed', conclusion: 'success' }]);
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git: async () => `${SHA_HELD}\trefs/heads/main\n`,
        listCheckRuns,
      });
      expect(await gate()).toEqual({ kind: 'claim' });
      expect(listCheckRuns).toHaveBeenCalledWith(SHA_HELD);
      expect(existsSync(file)).toBe(false);
    });

    it('holds when the held SHA is unchanged and CI is failing', async () => {
      writeBaseHold(file, gateHold);
      const git = vi.fn(async () => `${SHA_HELD}\trefs/heads/main\n`);
      const gate = createBaseHoldGate({
        file,
        repo: hold.repo,
        git,
        listCheckRuns: async () => [{ status: 'completed', conclusion: 'failure' }],
      });
      expect(await gate()).toEqual({ kind: 'hold', hold: gateHold });
      expect(git).toHaveBeenCalledWith('git ls-remote origin refs/heads/main');
    });
  });
});
