import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installShipHarness, logged, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('host slots (#3045)', () => {
  const slotsDir = (): string => process.env.FACTORY_HOST_SLOTS_DIR as string;
  const writeSlot = (n: number, over: Record<string, unknown>): void => {
    mkdirSync(slotsDir(), { recursive: true });
    writeFileSync(
      join(slotsDir(), `slot-${n}.json`),
      JSON.stringify({
        pid: process.pid,
        repo: 'on-par/a',
        issue: 1,
        phase: 'build',
        token: 't',
        acquiredAt: '',
        ...over,
      }),
    );
  };
  beforeEach(() => rmSync(slotsDir(), { recursive: true, force: true }));
  afterEach(() => rmSync(slotsDir(), { recursive: true, force: true }));

  it('status lists host slots held by other repos with repo, issue and builds 2/2 in use (#3045)', async () => {
    writeSlot(0, { repo: 'on-par/a', issue: 11, phase: 'build' });
    writeSlot(1, { repo: 'on-par/b', issue: 22, phase: 'check' });
    await runMain('status');
    const out = logged();
    expect(out).toContain('== Host slots ==');
    expect(out).toContain('on-par/a#11');
    expect(out).toContain('on-par/b#22');
    expect(out).toContain('builds 2/2 in use');
    expect(out.indexOf('== Host slots ==')).toBeLessThan(out.indexOf('== Queue =='));
  });

  it('status shows no host slots in use when the slot directory is empty or missing (#3045)', async () => {
    await runMain('status');
    expect(logged()).toContain('(no host slots in use)');
    expect(logged()).toContain('builds 0/2 in use');
    mkdirSync(slotsDir(), { recursive: true });
    await runMain('status');
    expect(logged()).toContain('builds 0/2 in use');
  });

  it('status marks a slot with a dead holder pid stale and leaves it out of the in-use count (#3045)', async () => {
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    writeSlot(0, { pid: deadPid, repo: 'on-par/a', issue: 11 });
    writeSlot(1, { repo: 'on-par/b', issue: 22 });
    await runMain('status');
    const out = logged();
    const staleLine = out.split('\n').find((l) => l.includes('on-par/a#11'));
    expect(staleLine).toContain('stale');
    expect(out).toContain('builds 1/2 in use');
    expect(existsSync(join(slotsDir(), 'slot-0.json'))).toBe(true);
  });
});
