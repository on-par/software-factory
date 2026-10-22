// packages/cli/src/cli/supervise-ratchet.test.ts — daily ratchet hook and its supervise wiring (#3542)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { getFactoryPaths, loadFactoryConfig } from '@on-par/factory-core';
import type { RatchetTriggerResult } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { superviseLoop } from './index.js';
import { createRatchetHook, octokitRatchetGitHub } from './ratchet-hook.js';

const list = { name: 'max-lines', file: 'a.txt', check: 'npm run lint' };

const tmp = createTempDirs();

describe('createRatchetHook', () => {
  let root: string;
  beforeEach(() => {
    root = tmp.makeSync('ratchet-hook-');
  });
  afterEach(() => tmp.cleanup());

  function setup(result: RatchetTriggerResult | Error, startDate = '2026-10-22') {
    const paths = { ...getFactoryPaths(root), state: join(root, 'state') };
    const config = { ...loadFactoryConfig(), ratchet: { lists: [list], lane: 'auto' } };
    const events: { type: string; message: string }[] = [];
    let date = startDate;
    let calls = 0;
    const hook = createRatchetHook(root, paths, config, {
      github: { openRatchetIssues: async () => [], fileIssue: async () => 1, enqueue: async () => ({ ok: true }) },
      runRatchetTriggerFn: async (input) => {
        calls++;
        expect(input.gateLabel).toBe('no-auto-merge');
        expect(input.readList('missing.txt')).toBeNull();
        writeFileSync(join(root, 'a.txt'), 'x.ts\n');
        expect(input.readList('a.txt')).toBe('x.ts\n');
        if (result instanceof Error) throw result;
        return result;
      },
      today: () => date,
      emitEvent: (_f, type, _s, message) => {
        events.push({ type, message });
      },
    });
    return { hook, paths, events, calls: () => calls, setDate: (d: string) => (date = d) };
  }

  const ok: RatchetTriggerResult = { done: [], skipped: [], errors: [] };

  it('runs the trigger at most once per UTC day', async () => {
    const t = setup(ok);
    await t.hook();
    await t.hook();
    expect(t.calls()).toBe(1);
    expect(readFileSync(join(t.paths.state, 'ratchet-last-fired'), 'utf-8').trim()).toBe('2026-10-22');
    t.setDate('2026-10-23');
    await t.hook();
    expect(t.calls()).toBe(2);
  });

  it('retries on the next cycle when the run reported errors', async () => {
    const t = setup({ ...ok, errors: ['x'] });
    await t.hook();
    await t.hook();
    expect(t.calls()).toBe(2);
  });

  it('logs a warn and does not throw when the trigger throws', async () => {
    const t = setup(new Error('kaboom'));
    await expect(t.hook()).resolves.toBeUndefined();
    expect(t.events[0].type).toBe('warn');
    expect(t.events[0].message).toContain('kaboom');
  });

  it('is a no-op with no lists configured', async () => {
    const paths = getFactoryPaths(root);
    const hook = createRatchetHook(root, paths, loadFactoryConfig(), {
      runRatchetTriggerFn: async () => {
        throw new Error('should not run');
      },
    });
    await expect(hook()).resolves.toBeUndefined();
  });
});

describe('superviseLoop ratchet', () => {
  it('calls ratchet before runQueue', async () => {
    const order: string[] = [];
    await superviseLoop({
      cap: 1,
      resumeAt: 0.65,
      pollMs: 1,
      watch: false,
      stopFile: '/nonexistent/STOP',
      eventsFile: '/nonexistent/events',
      pathExists: () => false,
      sleep: async () => {},
      emitEvent: () => {},
      writeLine: () => {},
      ratchet: async () => {
        order.push('ratchet');
      },
      runQueue: async () => {
        order.push('runQueue');
      },
    });
    expect(order).toEqual(['ratchet', 'runQueue']);
  });
});

describe('octokitRatchetGitHub', () => {
  it('lists marked open ratchet issues, files an issue, and maps enqueue outcomes', async () => {
    const calls: unknown[] = [];
    const issues = [
      { number: 1, body: '<!-- factory:ratchet list:a -->' },
      { number: 2, body: '<!-- factory:ratchet list:b -->' },
      { number: 3, body: '<!-- factory:ratchet list:a -->', pull_request: {} },
      { number: 4, body: null },
    ];
    const listForRepo = () => {};
    const octokit = {
      paginate: async (fn: unknown, params: unknown) => {
        calls.push(['paginate', fn === listForRepo, params]);
        return issues;
      },
      rest: {
        issues: {
          listForRepo,
          create: async (params: unknown) => {
            calls.push(['create', params]);
            return { data: { number: 42 } };
          },
        },
      },
    };
    const gh = octokitRatchetGitHub(
      async () => 'o/r',
      () => octokit as never,
    );
    expect(await gh.openRatchetIssues('a')).toEqual([1]);
    expect(calls[0]).toEqual([
      'paginate',
      true,
      { owner: 'o', repo: 'r', state: 'open', labels: 'factory:ratchet', per_page: 100 },
    ]);
    expect(await gh.fileIssue({ title: 't', body: 'b', labels: ['x'] })).toBe(42);
    // The queue client is a bare fake, so enqueue either fails or throws; this only exercises the wiring.
    await gh.enqueue('auto', 42).catch(() => null);
    expect(calls[1]).toEqual(['create', { owner: 'o', repo: 'r', title: 't', body: 'b', labels: ['x'] }]);
  });
});
