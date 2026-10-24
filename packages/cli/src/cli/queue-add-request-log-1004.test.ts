// `factory queue add` through the real CLI GitHub client (createFactoryOctokit) against a mocked
// fetch (#1004). Octokit's request logger wrote `POST /repos/o/r/labels - 422 with id …` to stderr
// even though ensureLabel swallowed the already_exists 422.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './index.js';
import { createFactoryOctokit } from './octokit.js';

const ALREADY_EXISTS = {
  status: 422,
  body: {
    message: 'Validation Failed',
    errors: [{ resource: 'Label', code: 'already_exists', field: 'name' }],
    documentation_url: 'https://docs.github.com/rest/issues/labels#create-a-label',
  },
};
const FORBIDDEN = {
  status: 403,
  body: {
    message: 'Resource not accessible by integration',
    documentation_url: 'https://docs.github.com/rest/issues/labels#create-a-label',
  },
};

/** GitHub double: repo has no queued issues, issue #1 has no labels, createLabel answers `createLabel`. */
function githubFetch(createLabel: { status: number; body: unknown }): typeof fetch {
  let written: string[] = []; // labels POSTed to #1, read back by enqueue's post-write verify (#3147)
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'x-github-request-id': 'E5FD:1004' },
      });
    if (method === 'POST' && url.pathname === '/repos/o/r/labels') return reply(createLabel.status, createLabel.body);
    if (method === 'POST' && url.pathname === '/repos/o/r/issues/1/labels') {
      written = JSON.parse(String(init?.body)).labels;
      return reply(200, []);
    }
    if (method === 'GET' && url.pathname === '/repos/o/r/issues/1/labels') {
      return reply(
        200,
        written.map((name) => ({ name })),
      );
    }
    if (method === 'GET' && url.pathname === '/repos/o/r/issues') return reply(200, []);
    return reply(404, { message: `unmocked ${method} ${url.pathname}` });
  }) as typeof fetch;
}

describe('queue add request log (#1004)', () => {
  const originalCwd = process.cwd();
  let root: string;
  let output: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-1004-'));
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
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  async function queueAdd(createLabel: { status: number; body: unknown }): Promise<number | undefined> {
    vi.stubGlobal('fetch', githubFetch(createLabel));
    const exec = async (command: string) => {
      if (command.includes('gh repo view')) return { stdout: 'o/r\n', stderr: '' };
      if (command.includes('rev-parse')) return { stdout: `${root}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    try {
      await main(['node', 'factory', 'queue', 'add', 'a b', '1'], {
        exec,
        execSync: () => '',
        octokit: () => createFactoryOctokit('t', { throttle: false }),
      });
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number') return code;
      throw err;
    }
    return process.exitCode as number | undefined;
  }

  it('prints no POST .../labels - 422 line when the labels already exist', async () => {
    const code = await queueAdd(ALREADY_EXISTS);

    const all = output.join('\n');
    expect(code ?? 0).toBe(0);
    expect(all).toContain('#1 queued');
    expect(all).not.toMatch(/POST \/repos\/o\/r\/labels - 422/);
    expect(all).not.toMatch(/ - \d{3} with id /);
  });

  it('still surfaces a 403 label-create failure with an actionable error', async () => {
    const code = await queueAdd(FORBIDDEN);

    const all = output.join('\n');
    expect(code).toBe(1);
    expect(all).toContain('#1 failed');
    expect(all).toContain('Resource not accessible by integration');
    expect(all).not.toContain('#1 queued');
  });
});
