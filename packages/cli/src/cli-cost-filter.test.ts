import { execSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli/index.js';

const tmp = createTempDirs();
let repo: string;
let cwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  cwd = process.cwd();
  repo = realpathSync(tmp.makeSync('cli-cost-filter-'));
  execSync('git init -q', { cwd: repo });
  mkdirSync(join(repo, '.factory', 'state'), { recursive: true });
  process.chdir(repo);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(cwd);
  await tmp.cleanup();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const logged = () => logSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const errored = () => errSpy.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
const runMain = (...args: string[]) => main(['node', 'factory', ...args]);

function seedCosts(rows: Array<{ ts: string; issue: string; task: string; model: string; cost: number }>) {
  writeFileSync(join(repo, '.factory', 'state', 'costs.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
}

describe('factory cost --since / --limit (#3187)', () => {
  it('cost --json --issue --since keeps only that issue at or after since', async () => {
    seedCosts([
      { ts: '2026-10-01T00:00:00Z', issue: '42', task: 'plan', model: 'a', cost: 1 },
      { ts: '2026-10-12T00:00:00Z', issue: '42', task: 'build', model: 'a', cost: 2 },
      { ts: '2026-10-12T00:00:00Z', issue: '43', task: 'build', model: 'a', cost: 4 },
    ]);
    await runMain('cost', '--json', '--issue', '42', '--since', '2026-10-10T00:00:00Z');
    const json = JSON.parse(logged());
    expect(json.rows).toHaveLength(1);
    expect(json.total.cost).toBe(2);
  });

  it('cost --json --since not-a-date exits 1 and prints no JSON', async () => {
    seedCosts([{ ts: '2026-10-01T00:00:00Z', issue: '42', task: 'plan', model: 'a', cost: 1 }]);
    await runMain('cost', '--json', '--since', 'not-a-date');
    expect(process.exitCode).toBe(1);
    expect(errored()).toContain('--since');
    expect(logged()).toBe('');
  });

  it('cost --json --limit keeps newest rows, totals uncapped', async () => {
    seedCosts(
      ['a', 'b', 'c'].map((task, i) => ({ ts: `2026-10-0${i + 1}T00:00:00Z`, issue: '1', task, model: 'm', cost: 1 })),
    );
    await runMain('cost', '--json', '--limit', '2');
    const json = JSON.parse(logged());
    expect(json.rows.map((r: { task: string }) => r.task)).toEqual(['b', 'c']);
    expect(json.total.cost).toBe(3);
  });

  it('cost text --since scopes the summary', async () => {
    seedCosts([
      { ts: '2026-10-01T00:00:00Z', issue: '1', task: 'a', model: 'oldmodel', cost: 1 },
      { ts: '2026-10-12T00:00:00Z', issue: '1', task: 'b', model: 'newmodel', cost: 2 },
    ]);
    await runMain('cost', '--since', '2026-10-10T00:00:00Z');
    expect(logged()).toContain('newmodel');
    expect(logged()).not.toContain('oldmodel');
  });

  it('cost --issue --limit caps listed entries but not Total', async () => {
    seedCosts([
      { ts: '2026-10-01T00:00:00Z', issue: '7', task: 'first', model: 'm', cost: 1 },
      { ts: '2026-10-02T00:00:00Z', issue: '7', task: 'second', model: 'm', cost: 1 },
    ]);
    await runMain('cost', '--issue', '7', '--limit', '1');
    expect(logged()).toContain('second');
    expect(logged()).not.toContain('first');
    expect(logged()).toContain('$2.00');
  });
});
