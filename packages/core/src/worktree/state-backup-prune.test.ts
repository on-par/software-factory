import { existsSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { formatStateBackupPruneReport, pruneStateBackups } from './state-backup-prune.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 0, 31);
const tmp = createTempDirs();

function makeDir(): string {
  return tmp.makeSync('state-backup-');
}

function touch(dir: string, name: string, ageDays: number): void {
  const path = join(dir, name);
  writeFileSync(path, name);
  const t = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, t, t);
}

afterEach(async () => {
  await tmp.cleanup();
});

describe('pruneStateBackups', () => {
  it('keeps the newest N files of each kind', () => {
    const dir = makeDir();
    for (let i = 0; i < 6; i++) touch(dir, `queue.bak.relaunch-${i}`, 30 + i);
    for (let i = 0; i < 5; i++) touch(dir, `config.json.bak${i}`, 30 + i);
    for (let i = 0; i < 4; i++) touch(dir, `run${i}-relaunch.log`, 30 + i);
    pruneStateBackups(dir, { keep: 2, maxAgeDays: 7 }, { now: () => NOW });
    expect(readdirSync(dir).sort()).toEqual([
      'config.json.bak0',
      'config.json.bak1',
      'queue.bak.relaunch-0',
      'queue.bak.relaunch-1',
      'run0-relaunch.log',
      'run1-relaunch.log',
    ]);
  });

  it('keeps every file newer than maxAgeDays', () => {
    const dir = makeDir();
    for (let i = 0; i < 5; i++) touch(dir, `queue.bak${i}`, 1);
    for (let i = 5; i < 10; i++) touch(dir, `queue.bak${i}`, 30);
    const report = pruneStateBackups(dir, { keep: 1, maxAgeDays: 7 }, { now: () => NOW });
    expect(readdirSync(dir).sort()).toEqual(['queue.bak0', 'queue.bak1', 'queue.bak2', 'queue.bak3', 'queue.bak4']);
    expect(report.removed).toHaveLength(5);
    expect(report.kept).toHaveLength(5);
  });

  it('never removes live config, queue, constitution, directories or symlinks', () => {
    const dir = makeDir();
    for (const name of ['config.json', 'config.yaml', 'queue', 'queue.proposed', 'constitution.md'])
      touch(dir, name, 90);
    mkdirSync(join(dir, 'state'));
    writeFileSync(join(dir, 'state', 'queue.bak.1'), 'x');
    mkdirSync(join(dir, 'quarantine'));
    writeFileSync(join(dir, 'quarantine', 'x.bak'), 'x');
    symlinkSync(join(dir, 'config.json'), join(dir, 'link.bak'));
    pruneStateBackups(dir, { keep: 0, maxAgeDays: 0 }, { now: () => NOW });
    for (const p of [
      'config.json',
      'config.yaml',
      'queue',
      'queue.proposed',
      'constitution.md',
      'state/queue.bak.1',
      'quarantine/x.bak',
      'link.bak',
    ]) {
      expect(existsSync(join(dir, p))).toBe(true);
    }
  });

  it('dry run reports what it would remove and deletes nothing', () => {
    const dir = makeDir();
    for (let i = 0; i < 4; i++) touch(dir, `queue.bak${i}`, 30 + i);
    const report = pruneStateBackups(dir, { keep: 1, maxAgeDays: 7 }, { dryRun: true, now: () => NOW });
    expect(readdirSync(dir)).toHaveLength(4);
    expect(report.removed.map((f) => f.name)).toEqual(['queue.bak1', 'queue.bak2', 'queue.bak3']);
    const text = formatStateBackupPruneReport(report);
    expect(text).toContain('would remove 3');
    for (const n of ['queue.bak1', 'queue.bak2', 'queue.bak3']) expect(text).toContain(n);
  });

  it('applied output says removed and kept', () => {
    const dir = makeDir();
    for (let i = 0; i < 3; i++) touch(dir, `queue.bak${i}`, 30 + i);
    const text = formatStateBackupPruneReport(pruneStateBackups(dir, { keep: 1, maxAgeDays: 7 }, { now: () => NOW }));
    expect(text).toContain('removed 2, kept 1');
  });

  it('a fixture of 500 old backup files ends with N kept', () => {
    const dir = makeDir();
    for (let i = 0; i < 500; i++) touch(dir, `queue.bak.relaunch-${i}`, 30 + i / 10);
    pruneStateBackups(dir, { keep: 3, maxAgeDays: 7 }, { now: () => NOW });
    expect(readdirSync(dir).sort()).toEqual(['queue.bak.relaunch-0', 'queue.bak.relaunch-1', 'queue.bak.relaunch-2']);
  });

  it('an ENOENT dir gives an empty report', () => {
    const dir = join(makeDir(), 'missing');
    const report = pruneStateBackups(dir, { keep: 3, maxAgeDays: 7 });
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([]);
    expect(formatStateBackupPruneReport(report)).toBe(`state backups: none in ${dir}`);
  });
});
