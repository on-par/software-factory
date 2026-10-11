import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type BaseHold,
  clearBaseHold,
  createBaseHoldGate,
  evaluateBaseHold,
  formatBaseHoldCleared,
  writeBaseHold,
} from './base-hold.js';

const SHA_HELD = 'a'.repeat(40);
const SHA_NEW = 'b'.repeat(40);
const hold: BaseHold = {
  repo: 'on-par/software-factory',
  baseSha: SHA_HELD,
  failingChecks: ['tests'],
  since: '2026-01-01T00:00:00.000Z',
};

describe('base-hold clearing (#2350)', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'factory-base-hold-clear-'));
    file = join(dir, 'state', 'base-hold.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('deletes the hold and emits sha-changed when origin/main moved', async () => {
    writeBaseHold(file, hold);
    const onCleared = vi.fn();
    const baseCiGreen = vi.fn(async () => true);
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      baseCiGreen,
      onCleared,
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledWith({ hold, reason: 'sha-changed', currentSha: SHA_NEW });
    expect(baseCiGreen).not.toHaveBeenCalled();
  });

  it('deletes the hold and emits ci-green when main CI on the held SHA is green', async () => {
    writeBaseHold(file, hold);
    const onCleared = vi.fn();
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_HELD,
      baseCiGreen: async () => true,
      onCleared,
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
    expect(onCleared).toHaveBeenCalledWith({ hold, reason: 'ci-green', currentSha: SHA_HELD });
  });

  it('emits nothing when there is no hold, or the hold is not cleared', async () => {
    const cases: Array<{
      name: string;
      write: BaseHold | null;
      sha: () => Promise<string | null>;
      green: () => Promise<boolean>;
    }> = [
      { name: 'no file', write: null, sha: async () => SHA_NEW, green: async () => true },
      { name: 'other repo', write: { ...hold, repo: 'x/y' }, sha: async () => SHA_NEW, green: async () => true },
      { name: 'null sha', write: hold, sha: async () => null, green: async () => true },
      {
        name: 'throwing sha',
        write: hold,
        sha: async () => {
          throw new Error('offline');
        },
        green: async () => true,
      },
      { name: 'not green', write: hold, sha: async () => SHA_HELD, green: async () => false },
      {
        name: 'throwing ci',
        write: hold,
        sha: async () => SHA_HELD,
        green: async () => {
          throw new Error('api');
        },
      },
    ];
    for (const c of cases) {
      if (c.write) writeBaseHold(file, c.write);
      const onCleared = vi.fn();
      await evaluateBaseHold(file, hold.repo, { currentBaseSha: c.sha, baseCiGreen: c.green, onCleared });
      expect(onCleared, c.name).not.toHaveBeenCalled();
      expect(existsSync(file), c.name).toBe(c.write !== null);
      await rm(file, { force: true });
    }
  });

  it('clears on the next poll after a hold', async () => {
    writeBaseHold(file, hold);
    const onCleared = vi.fn();
    const held = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_HELD,
      baseCiGreen: async () => false,
      onCleared,
    });
    expect(held.kind).toBe('hold');
    expect(existsSync(file)).toBe(true);
    const next = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      baseCiGreen: async () => false,
      onCleared,
    });
    expect(next).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('only one of two concurrent polls emits', async () => {
    writeBaseHold(file, hold);
    const onCleared = vi.fn();
    const deps = { currentBaseSha: async () => SHA_NEW, baseCiGreen: async () => false, onCleared };
    const results = await Promise.all([
      evaluateBaseHold(file, hold.repo, deps),
      evaluateBaseHold(file, hold.repo, deps),
    ]);
    expect(results).toEqual([{ kind: 'claim' }, { kind: 'claim' }]);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('a throwing onCleared still returns claim and deletes the hold', async () => {
    writeBaseHold(file, hold);
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      baseCiGreen: async () => false,
      onCleared: () => {
        throw new Error('observer failed');
      },
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
  });

  describe('clearBaseHold', () => {
    it('returns false for a missing file', () => {
      expect(clearBaseHold(file, SHA_HELD)).toBe(false);
    });

    it('returns false and keeps the file for a different baseSha', () => {
      writeBaseHold(file, hold);
      expect(clearBaseHold(file, SHA_NEW)).toBe(false);
      expect(existsSync(file)).toBe(true);
    });

    it('returns true and deletes the file for a match', () => {
      writeBaseHold(file, hold);
      expect(clearBaseHold(file, SHA_HELD)).toBe(true);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('formatBaseHoldCleared', () => {
    it('names the sha-changed reason and both SHA prefixes', () => {
      const msg = formatBaseHoldCleared({ hold, reason: 'sha-changed', currentSha: SHA_NEW });
      expect(msg).toContain('reason: sha-changed');
      expect(msg).toContain(SHA_HELD.slice(0, 8));
      expect(msg).toContain(SHA_NEW.slice(0, 8));
    });

    it('names the ci-green reason and the SHA prefix', () => {
      const msg = formatBaseHoldCleared({ hold, reason: 'ci-green', currentSha: SHA_HELD });
      expect(msg).toContain('reason: ci-green');
      expect(msg).toContain(SHA_HELD.slice(0, 8));
    });
  });

  it('createBaseHoldGate forwards onCleared', async () => {
    writeBaseHold(file, hold);
    const onCleared = vi.fn();
    const gate = createBaseHoldGate({
      file,
      repo: hold.repo,
      git: async () => `${SHA_NEW}\trefs/heads/main\n`,
      listCheckRuns: async () => [],
      onCleared,
    });
    expect(await gate()).toEqual({ kind: 'claim' });
    expect(onCleared).toHaveBeenCalledWith({ hold, reason: 'sha-changed', currentSha: SHA_NEW });
    expect(existsSync(file)).toBe(false);
  });
});
