// A queued issue with no `factory:order:<n>` label through the real CLI GitHub client against a mocked fetch (#3192):
// `queue list --json` exits 0, lists the valid issue and reports the bad one; the lane claims only the valid one.
import { execFileSync } from 'node:child_process';

import { createGithubQueue, createOctokitQueueClient } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './index.js';
import { createFactoryOctokit } from './octokit.js';

/** In-memory GitHub double: #2253 is at factory:order:1, #2319 is parked with no order label, both in lane self-repair. */
function githubFetch(): typeof fetch {
  const state = new Map<number, Set<string>>([
    [2253, new Set(['factory:queued', 'factory:lane:self-repair', 'factory:order:1'])],
    [2319, new Set(['factory:queued', 'factory:parked', 'factory:lane:self-repair'])],
  ]);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body));
    if (method === 'GET' && url.pathname === '/repos/o/r/issues') {
      const wanted = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      return reply(
        200,
        [...state]
          .filter(([, labels]) => wanted.every((l) => labels.has(l)))
          .map(([number, labels]) => ({
            number,
            title: `issue ${number}`,
            labels: [...labels].map((name) => ({ name })),
          })),
      );
    }
    if (method === 'POST' && url.pathname === '/repos/o/r/labels') return reply(201, {});
    const labelsMatch = /^\/repos\/o\/r\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(url.pathname);
    if (labelsMatch !== null) {
      const labels = state.get(Number(labelsMatch[1])) ?? new Set<string>();
      state.set(Number(labelsMatch[1]), labels);
      if (method === 'DELETE' && labelsMatch[2] !== undefined) labels.delete(decodeURIComponent(labelsMatch[2]));
      if (method === 'POST') {
        const added: string[] = Array.isArray(body) ? body : (body.labels ?? []);
        for (const l of added) labels.add(l);
      }
      return reply(
        200,
        [...labels].map((name) => ({ name })),
      );
    }
    return reply(404, { message: `unmocked ${method} ${url.pathname}` });
  }) as typeof fetch;
}

const tmp = createTempDirs();

describe('missing factory:order label (#3192)', () => {
  const originalCwd = process.cwd();
  let root: string;
  let output: string[];

  beforeEach(() => {
    root = tmp.makeSync('factory-3192-');
    execFileSync('git', ['init', '-q', root]);
    process.chdir(root);
    output = [];
    const capture = (...a: unknown[]) => void output.push(a.map(String).join(' '));
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation(capture);
    }
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      capture(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      capture(String(chunk));
      return true;
    });
    vi.stubGlobal('fetch', githubFetch());
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    tmp.cleanup();
  });

  it('queue list --json exits 0, lists #2253 and reports #2319 as missing-order-label', async () => {
    const exec = async (command: string) => {
      if (command.includes('gh repo view')) return { stdout: 'o/r\n', stderr: '' };
      if (command.includes('rev-parse')) return { stdout: `${root}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await main(['node', 'factory', 'queue', 'list', '--json'], {
      exec,
      execSync: () => '',
      octokit: () => createFactoryOctokit('t'),
    });

    expect(process.exitCode).toBeUndefined();
    const line = output.find((l) => l.includes('"schemaVersion"'));
    expect(line).toBeDefined();
    const json = JSON.parse(line!);
    expect(json.lanes).toEqual([
      {
        lane: 'self-repair',
        items: [{ issue: 2253, title: 'issue 2253', status: 'queued', order: 1, claimedBy: null }],
      },
    ]);
    expect(json.orderConflicts).toEqual([
      { lane: 'self-repair', order: null, issues: [2319], reason: 'missing-order-label' },
    ]);
  });

  it('the lane claims #2253 and skips #2319', async () => {
    const seen: unknown[] = [];
    const queue = createGithubQueue({
      client: createOctokitQueueClient(createFactoryOctokit('t')),
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
      onOrderConflict: (c) => seen.push(c),
    });

    expect((await queue.claimNext('self-repair'))?.issue).toBe(2253);
    expect(await queue.claimNext('self-repair')).toBeNull();
    expect(seen).toContainEqual({ lane: 'self-repair', position: null, issues: [2319], reason: 'missing-order-label' });
  });
});
