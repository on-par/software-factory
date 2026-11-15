import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { autoPruneStateBackups, stateBackupPolicyFrom } from './state-backup-gc.js';

const cfg = { worktree: { stateBackupKeep: 2, stateBackupMaxAgeDays: 7 } } as Parameters<
  typeof stateBackupPolicyFrom
>[0];
const tmp = createTempDirs();

function makeDir(): string {
  return tmp.makeSync('state-gc-');
}

afterEach(async () => {
  await tmp.cleanup();
});

describe('state-backup-gc', () => {
  it('maps the config keys to a policy', () => {
    expect(stateBackupPolicyFrom(cfg)).toEqual({ keep: 2, maxAgeDays: 7 });
  });

  it('applies the prune and logs counts as a worktree-gc event', () => {
    const dir = makeDir();
    const old = Date.now() / 1000 - 30 * 86400;
    for (let i = 0; i < 5; i++) {
      const p = join(dir, `queue.bak${i}`);
      writeFileSync(p, 'x');
      utimesSync(p, old - i, old - i);
    }
    const events: [string, string][] = [];
    const report = autoPruneStateBackups(dir, cfg, (type, msg) => events.push([type, msg]));
    expect(report?.removed).toHaveLength(3);
    expect(readdirSync(dir).sort()).toEqual(['queue.bak0', 'queue.bak1']);
    expect(events).toEqual([['worktree-gc', 'pruned 3 state backup file(s), kept 2']]);
  });

  it('stays silent when there are no backups', () => {
    const events: string[] = [];
    autoPruneStateBackups(makeDir(), cfg, (type) => events.push(type));
    expect(events).toEqual([]);
  });

  it('logs a warn and returns null when the prune throws', () => {
    const dir = makeDir();
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'x');
    const events: [string, string][] = [];
    expect(autoPruneStateBackups(file, cfg, (type, msg) => events.push([type, msg]))).toBeNull();
    expect(events[0]?.[0]).toBe('warn');
    expect(events[0]?.[1]).toContain('state backup prune failed');
    expect(existsSync(file)).toBe(true);
  });
});
