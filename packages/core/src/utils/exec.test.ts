import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultExecFn } from './exec.js';

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: any) {
    return err?.code === 'ESRCH';
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('defaultExecFn', () => {
  it('resolves stdout for a quick command', async () => {
    const { stdout } = await defaultExecFn('echo hi', {});

    expect(stdout).toContain('hi');
  });

  it('passes timeoutMs through as a real kill timeout', async () => {
    const err: any = await defaultExecFn('sleep 2', { timeoutMs: 50 }).catch((e) => e);

    expect(err).toBeTruthy();
    expect(err.killed).toBe(true);
  });

  it('passes cwd through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exec-test-'));
    try {
      const realDir = await realpath(dir);
      const { stdout } = await defaultExecFn('pwd', { cwd: dir });

      expect(await realpath(stdout.trim())).toBe(realDir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('merges opts.env over the parent env instead of replacing it', async () => {
    const { stdout } = await defaultExecFn('node -p "process.env.FACTORY_APP_PORT + \':\' + typeof process.env.PATH"', {
      env: { FACTORY_APP_PORT: '3142' },
    });

    expect(stdout.trim()).toBe('3142:string');
  });

  it('leaves the environment unchanged when opts.env is omitted', async () => {
    const { stdout } = await defaultExecFn('node -p "typeof process.env.PATH"', {});

    expect(stdout.trim()).toBe('string');
  });

  describe.skipIf(process.platform === 'win32')('onPgid grandchild sweep', () => {
    it('fires onPgid and, on timeout, kills the grandchild too', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'exec-onpgid-'));
      const pidFile = join(dir, 'gc.pid');
      try {
        let reportedPid: number | undefined;

        const err: any = await defaultExecFn(`sleep 30 & echo $! > ${pidFile}; wait`, {
          timeoutMs: 300,
          killGraceMs: 100,
          onPgid: (pgid) => {
            reportedPid = pgid;
          },
        }).catch((e) => e);

        expect(err).toBeTruthy();
        expect(err.killed).toBe(true);
        expect(reportedPid).toBeDefined();

        let raw = '';
        const deadline = Date.now() + 1000;
        while (Date.now() < deadline && raw === '') {
          try {
            raw = (await readFile(pidFile, 'utf-8')).trim();
          } catch {
            // not written yet
          }
          if (raw === '') await new Promise((r) => setTimeout(r, 50));
        }
        const grandchildPid = Number(raw);

        await waitUntil(() => isDead(grandchildPid), 2000);
        expect(isDead(grandchildPid)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 10000);

    it('does not spawn detached when onPgid is absent (unchanged behavior)', async () => {
      const { stdout } = await defaultExecFn('echo hi', { timeoutMs: 1000 });
      expect(stdout).toContain('hi');
    });
  });
});

describe('defaultExecFn GitHub credential isolation', () => {
  const TOKEN = 'ghp_parentTokenValue0123456789';
  const PRINT_GITHUB_VARS =
    "node -p \"Object.keys(process.env).filter((k) => /^(GITHUB_TOKEN|GH_TOKEN|GITHUB_PAT|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$/.test(k)).sort().join(',') + '|' + typeof process.env.PATH\"";

  function stubGitHubCredentials(): void {
    vi.stubEnv('GITHUB_TOKEN', TOKEN);
    vi.stubEnv('GH_TOKEN', 'gh-token-opaque-value');
    vi.stubEnv('GITHUB_PAT', 'github-pat-opaque-value');
    vi.stubEnv('GH_ENTERPRISE_TOKEN', 'gh-enterprise-opaque');
    vi.stubEnv('GITHUB_ENTERPRISE_TOKEN', 'github-enterprise-opaque');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never hands GitHub credentials to a child by default (agent CLI path), with or without opts.env', async () => {
    stubGitHubCredentials();

    expect((await defaultExecFn(PRINT_GITHUB_VARS, {})).stdout.trim()).toBe('|string');
    expect((await defaultExecFn(PRINT_GITHUB_VARS, { env: { PORT: '3142' } })).stdout.trim()).toBe('|string');
  });

  it('strips a credential even when it is passed explicitly in opts.env', async () => {
    const { stdout } = await defaultExecFn(PRINT_GITHUB_VARS, { env: { GITHUB_TOKEN: 'explicit-token-value' } });

    expect(stdout.trim()).toBe('|string');
  });

  it('passes the credentials through only when the call opts into githubAuth (gh/git)', async () => {
    stubGitHubCredentials();

    const { stdout } = await defaultExecFn(PRINT_GITHUB_VARS, { githubAuth: true });

    expect(stdout.trim()).toBe('GH_ENTERPRISE_TOKEN,GH_TOKEN,GITHUB_ENTERPRISE_TOKEN,GITHUB_PAT,GITHUB_TOKEN|string');
  });

  it("redacts GitHub credentials from a rejected command's message, cmd and stderr", async () => {
    stubGitHubCredentials();

    const err: any = await defaultExecFn(`echo "auth ${TOKEN} gh-token-opaque-value" >&2; exit 3 # ${TOKEN}`, {
      githubAuth: true,
    }).catch((e) => e);

    expect(err.code).toBe(3);
    for (const text of [err.message, err.cmd, err.stderr, err.stack]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('gh-token-opaque-value');
    }
    expect(err.stderr).toContain('auth [redacted] [redacted]');
  });

  describe.skipIf(process.platform === 'win32')('onPgid (detached) path', () => {
    it('strips GitHub credentials from the detached child too', async () => {
      stubGitHubCredentials();

      const { stdout } = await defaultExecFn(PRINT_GITHUB_VARS, { onPgid: () => {} });

      expect(stdout.trim()).toBe('|string');
    });

    it('passes them on the detached path only with githubAuth', async () => {
      stubGitHubCredentials();

      const { stdout } = await defaultExecFn(PRINT_GITHUB_VARS, { onPgid: () => {}, githubAuth: true });

      expect(stdout.trim()).toBe('GH_ENTERPRISE_TOKEN,GH_TOKEN,GITHUB_ENTERPRISE_TOKEN,GITHUB_PAT,GITHUB_TOKEN|string');
    });

    it('redacts the detached rejection message and stderr', async () => {
      stubGitHubCredentials();

      const err: any = await defaultExecFn(`echo "${TOKEN}" >&2; exit 4`, { onPgid: () => {} }).catch((e) => e);

      expect(err.code).toBe(4);
      expect(err.message).not.toContain(TOKEN);
      expect(err.cmd).not.toContain(TOKEN);
      expect(err.stderr.trim()).toBe('[redacted]');
    });
  });
});
