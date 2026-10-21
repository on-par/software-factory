// Duplicate `factory:order:<n>` positions through the real CLI GitHub client against a mocked fetch (#3101):
// `queue list --json` reports the conflict and lists every duplicate, and the lane claims them by issue number.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGithubQueue, createOctokitQueueClient } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './index.js';
import { createFactoryOctokit } from './octokit.js';

/** In-memory GitHub double: issues #3/#4 share factory:order:1, #5 is at factory:order:2, all in lane dup. */
function githubFetch(): typeof fetch {
  const state = new Map<number, Set<string>>(
    [
      [3, 1],
      [4, 1],
      [5, 2],
    ].map(([n, order]) => [n, new Set(['factory:queued', 'factory:lane:dup', `factory:order:${order}`])]),
  );
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

describe('duplicate factory:order positions (#3101)', () => {
  const originalCwd = process.cwd();
  let root: string;
  let output: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-3101-'));
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
    rmSync(root, { recursive: true, force: true });
  });

  it('queue list --json reports the dup order conflict and lists #3, #4, #5', async () => {
    const exec = async (command: string) => {
      if (command.includes('gh repo view')) return { stdout: 'o/r\n', stderr: '' };
      if (command.includes('rev-parse')) return { stdout: `${root}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    await main(['node', 'factory', 'queue', 'list', '--json'], {
      exec,
      execSync: () => '',
      octokit: () => createFactoryOctokit('t', { throttle: false }),
    });

    const line = output.find((l) => l.includes('"schemaVersion"'));
    expect(line).toBeDefined();
    const json = JSON.parse(line!);
    expect(json.schemaVersion).toBe(1);
    expect(json.lanes[0].items.map((i: { issue: number }) => i.issue)).toEqual([3, 4, 5]);
    expect(json.lanes[0].items.map((i: { order: number }) => i.order)).toEqual([1, 2, 3]);
    expect(json.orderConflicts).toEqual([{ lane: 'dup', order: 1, issues: [3, 4] }]);
  });

  it('the lane claims #3, then #4, then #5', async () => {
    const queue = createGithubQueue({
      client: createOctokitQueueClient(createFactoryOctokit('t', { throttle: false })),
      owner: 'o',
      repo: 'r',
      claimantId: 'aaa-1',
    });

    const claimed: Array<number | undefined> = [];
    for (let i = 0; i < 3; i++) claimed.push((await queue.claimNext('dup'))?.issue);

    expect(claimed).toEqual([3, 4, 5]);
    expect(await queue.claimNext('dup')).toBeNull();
  });
});
