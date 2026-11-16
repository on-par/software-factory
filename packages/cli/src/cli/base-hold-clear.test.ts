import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { baseChecksVerdict, resetBasePushWorkflowReports } from './base-health-ci.js';

import {
  type BaseHold,
  type BaseHoldCleared,
  clearBaseHold,
  createBaseHoldGate,
  evaluateBaseHold,
  formatBaseHoldCleared,
  formatBaseHoldKept,
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
    const cleared: BaseHoldCleared[] = [];
    const asked: string[] = [];
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      requiredChecksVerdict: async (sha: string) => {
        asked.push(sha);
        return { green: true, reason: 'ok', basis: 'required checks: CI' };
      },
      onCleared: (c) => cleared.push(c),
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(cleared).toEqual([{ hold, reason: 'sha-changed', currentSha: SHA_NEW, basis: 'required checks: CI' }]);
    expect(asked).toEqual([SHA_NEW]);
  });

  it('deletes the hold and emits ci-green when main CI on the held SHA is green', async () => {
    writeBaseHold(file, hold);
    const cleared: BaseHoldCleared[] = [];
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_HELD,
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      onCleared: (c) => cleared.push(c),
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(cleared).toEqual([{ hold, reason: 'ci-green', currentSha: SHA_HELD }]);
  });

  it('emits nothing when there is no hold, or the hold is not cleared', async () => {
    const cases: Array<{
      name: string;
      write: BaseHold | null;
      sha: () => Promise<string | null>;
      green: () => Promise<boolean>;
    }> = [
      { name: 'no file', write: null, sha: async () => SHA_NEW, green: async () => true },
      { name: 'moved, not green', write: hold, sha: async () => SHA_NEW, green: async () => false },
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
      const cleared: BaseHoldCleared[] = [];
      await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: c.sha,
        requiredChecksVerdict: async () => ({ green: await c.green(), reason: 'x' }),
        onCleared: (c) => cleared.push(c),
      });
      expect(cleared, c.name).toEqual([]);
      expect(existsSync(file), c.name).toBe(c.write !== null);
      await rm(file, { force: true });
    }
  });

  it('clears on the next poll after a hold', async () => {
    writeBaseHold(file, hold);
    const cleared: BaseHoldCleared[] = [];
    const held = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_HELD,
      requiredChecksVerdict: async () => ({ green: false, reason: 'x' }),
      onCleared: (c) => cleared.push(c),
    });
    expect(held.kind).toBe('hold');
    expect(existsSync(file)).toBe(true);
    const next = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      onCleared: (c) => cleared.push(c),
    });
    expect(next).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
    expect(cleared).toHaveLength(1);
  });

  it('only one of two concurrent polls emits', async () => {
    writeBaseHold(file, hold);
    const cleared: BaseHoldCleared[] = [];
    const deps = {
      currentBaseSha: async () => SHA_NEW,
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      onCleared: (c: BaseHoldCleared) => cleared.push(c),
    };
    const results = await Promise.all([
      evaluateBaseHold(file, hold.repo, deps),
      evaluateBaseHold(file, hold.repo, deps),
    ]);
    expect(results).toEqual([{ kind: 'claim' }, { kind: 'claim' }]);
    expect(cleared).toHaveLength(1);
  });

  it('a throwing onCleared still returns claim and deletes the hold', async () => {
    writeBaseHold(file, hold);
    const decision = await evaluateBaseHold(file, hold.repo, {
      currentBaseSha: async () => SHA_NEW,
      requiredChecksVerdict: async () => ({ green: true, reason: 'ok' }),
      onCleared: () => {
        throw new Error('observer failed');
      },
    });
    expect(decision).toEqual({ kind: 'claim' });
    expect(existsSync(file)).toBe(false);
  });

  describe('moved SHA waits for green code-health CI (#3620)', () => {
    it.each([
      { name: 'pending', reason: 'ci pending', verdict: async () => ({ green: false, reason: 'ci pending' }) },
      { name: 'failing', reason: 'ci failure', verdict: async () => ({ green: false, reason: 'ci failure' }) },
      { name: 'missing', reason: 'missing ci', verdict: async () => ({ green: false, reason: 'missing ci' }) },
      {
        name: 'throwing',
        reason: 'CI lookup failed',
        verdict: async (): Promise<{ green: boolean; reason: string }> => {
          throw new Error('api down');
        },
      },
    ])('keeps the hold when origin/main moved but the new SHA code-health CI is $name (#3620)', async (c) => {
      writeBaseHold(file, hold);
      const cleared: BaseHoldCleared[] = [];
      const asked: string[] = [];
      const decision = await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: async () => SHA_NEW,
        requiredChecksVerdict: async (sha: string) => {
          asked.push(sha);
          return c.verdict();
        },
        onCleared: (c) => cleared.push(c),
      });
      expect(decision.kind).toBe('hold');
      if (decision.kind !== 'hold') return;
      expect(decision.hold).toEqual(hold);
      expect(decision.currentSha).toBe(SHA_NEW);
      expect(decision.ciReason).toContain(c.reason);
      expect(existsSync(file)).toBe(true);
      expect(cleared).toEqual([]);
      expect(asked).toEqual([SHA_NEW]);
    });

    it('clears with sha-changed and the basis only when the moved SHA code-health CI is green (#3620)', async () => {
      writeBaseHold(file, hold);
      const cleared: BaseHoldCleared[] = [];
      const decision = await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: async () => SHA_NEW,
        requiredChecksVerdict: async () => ({ green: true, reason: 'ok', basis: 'required checks: CI' }),
        onCleared: (c) => cleared.push(c),
      });
      expect(decision).toEqual({ kind: 'claim' });
      expect(existsSync(file)).toBe(false);
      expect(cleared).toEqual([{ hold, reason: 'sha-changed', currentSha: SHA_NEW, basis: 'required checks: CI' }]);
    });

    it('a failed Nightly Integration push workflow on the moved SHA does not keep the hold (#3620)', async () => {
      resetBasePushWorkflowReports();
      writeBaseHold(file, hold);
      const octokit = Object.assign({} as Octokit, {
        rest: {
          repos: {
            getStatusChecksProtection: async () => {
              throw Object.assign(new Error('Forbidden'), { status: 403 });
            },
            getBranchRules: async () => ({ data: [] }),
          },
          checks: {
            listForRef: async () => ({
              data: {
                check_runs: [
                  { name: 'ci', status: 'completed', conclusion: 'success', check_suite: { id: 1 } },
                  { name: 'nightly', status: 'completed', conclusion: 'failure', check_suite: { id: 2 } },
                ],
              },
            }),
          },
          actions: {
            listWorkflowRunsForRepo: async () => ({
              data: {
                workflow_runs: [
                  { name: 'CI', status: 'completed', conclusion: 'success', check_suite_id: 1 },
                  { name: 'Nightly Integration', status: 'completed', conclusion: 'failure', check_suite_id: 2 },
                ],
              },
            }),
          },
        },
      });
      const cleared: BaseHoldCleared[] = [];
      const decision = await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: async () => SHA_NEW,
        requiredChecksVerdict: baseChecksVerdict(octokit, 'o', 'r', {}),
        onCleared: (c) => cleared.push(c),
      });
      expect(decision).toEqual({ kind: 'claim' });
      expect(existsSync(file)).toBe(false);
      expect(cleared).toEqual([expect.objectContaining({ basis: 'push checks: ci' })]);
    });

    it('a moved SHA with noCodeHealthChecks or no CI lookup clears as before (#3620)', async () => {
      writeBaseHold(file, hold);
      const cleared: BaseHoldCleared[] = [];
      await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: async () => SHA_NEW,
        requiredChecksVerdict: async () => ({
          green: false,
          reason: 'no code-health checks',
          noCodeHealthChecks: true,
        }),
        onCleared: (c) => cleared.push(c),
      });
      writeBaseHold(file, hold);
      await evaluateBaseHold(file, hold.repo, {
        currentBaseSha: async () => SHA_NEW,
        onCleared: (c) => cleared.push(c),
      });
      expect(cleared).toEqual([
        { hold, reason: 'sha-changed', currentSha: SHA_NEW, basis: 'no code-health checks configured' },
        { hold, reason: 'sha-changed', currentSha: SHA_NEW, basis: 'no CI lookup configured' },
      ]);
      expect(existsSync(file)).toBe(false);
    });

    it('formatBaseHoldKept names the held and current SHA and the CI reason; formatBaseHoldCleared names the new SHA and code-health basis (#3620)', () => {
      const kept = formatBaseHoldKept('lane-1', { kind: 'hold', hold, ciReason: 'ci pending', currentSha: SHA_NEW });
      expect(kept).toContain(SHA_HELD.slice(0, 8));
      expect(kept).toContain(`moved to ${SHA_NEW.slice(0, 8)}`);
      expect(kept).toContain('ci pending');
      expect(formatBaseHoldKept('lane-1', { kind: 'hold', hold, ciReason: 'x' })).toContain('origin/main unchanged');
      const cleared = formatBaseHoldCleared({
        hold,
        reason: 'sha-changed',
        currentSha: SHA_NEW,
        basis: 'required checks: CI',
      });
      expect(cleared).toContain('reason: sha-changed');
      expect(cleared).toContain(SHA_NEW.slice(0, 8));
      expect(cleared).toContain('code-health CI is green');
      expect(cleared).toContain('required checks: CI');
      const escape = formatBaseHoldCleared({
        hold,
        reason: 'sha-changed',
        currentSha: SHA_NEW,
        basis: 'no CI lookup configured',
      });
      expect(escape).toContain('no CI lookup configured');
      expect(escape).not.toContain('code-health CI is green');
    });
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

    it('names the basis of a ci-green verdict', () => {
      const msg = formatBaseHoldCleared({
        hold,
        reason: 'ci-green',
        currentSha: SHA_HELD,
        basis: 'required checks: ci',
      });
      expect(msg).toContain('required checks: ci');
    });
  });

  it('createBaseHoldGate forwards onCleared', async () => {
    writeBaseHold(file, hold);
    const cleared: BaseHoldCleared[] = [];
    const gate = createBaseHoldGate({
      file,
      repo: hold.repo,
      git: async () => `${SHA_NEW}\trefs/heads/main\n`,
      onCleared: (c) => cleared.push(c),
    });
    expect(await gate()).toEqual({ kind: 'claim' });
    expect(cleared).toEqual([{ hold, reason: 'sha-changed', currentSha: SHA_NEW, basis: 'no CI lookup configured' }]);
    expect(existsSync(file)).toBe(false);
  });
});
