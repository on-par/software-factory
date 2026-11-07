// Base health on a real git repo whose only check surface is scripts/verify.sh: a timeout, an
// environment exit (78) or a missing command is inconclusive, never a red base; a real test
// failure stays red and carries bounded evidence.
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { EventKind } from '../events/kinds.js';
import type { ModelRouter } from '../router/index.js';
import type { BaselineReport } from './baseline.js';
import { type BaseHealthOptions, checkBaseHealth } from './base-health.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

const MARKER = 'verify: ENVIRONMENT ERROR: loopback bind denied (EPERM)';

async function repoWithVerify(body: string): Promise<string> {
  const dir = await tempDirs.make('base-health-inconclusive-');
  await mkdir(join(dir, 'scripts'));
  await writeFile(join(dir, 'scripts/verify.sh'), `#!/usr/bin/env bash\n${body}\n`);
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return dir;
}

async function health(body: string, extra: Partial<BaseHealthOptions> = {}) {
  const worktree = await repoWithVerify(body);
  const log = vi.fn<(type: EventKind, msg: string) => void>();
  const res = await checkBaseHealth({
    worktree,
    constitution: null,
    router: {} as ModelRouter,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    testsTimeoutSeconds: 1,
    log,
    ...extra,
    deps: { memo: new Map<string, Promise<BaselineReport>>(), confirmed: new Set<string>() },
  });
  return { res, log, worktree, messages: log.mock.calls.map((c) => `${c[0]}: ${c[1]}`) };
}

describe('checkBaseHealth: environment and setup failures are inconclusive, not red', () => {
  it('a tests timeout is inconclusive with the command, timeout seconds and output tail', async () => {
    const { res, messages } = await health('echo starting suite\nexec sleep 10');
    expect(res.kind).toBe('inconclusive');
    expect(res.failingChecks).toEqual([]);
    expect(res.evidence).toEqual([
      expect.objectContaining({
        checker: 'tests',
        cause: 'timeout',
        command: 'bash scripts/verify.sh --no-e2e',
        timeoutSeconds: 1,
        tail: expect.stringContaining('timed out after 1s'),
      }),
    ]);
    expect(messages.join('\n')).not.toMatch(/is red/);
    expect(messages.join('\n')).toMatch(/inconclusive.*tests: timeout after 1s/s);
  }, 20_000);

  it('a tests timeout stays inconclusive when GitHub CI is green (no CI fallback for tests)', async () => {
    const requiredChecksVerdict = vi.fn(async () => ({ green: true, reason: 'all required checks succeeded' }));
    const { res } = await health('exec sleep 10', { requiredChecksVerdict });
    expect(res.kind).toBe('inconclusive');
    expect(res.failingChecks).toEqual([]);
  }, 20_000);

  it.each([
    ['with the sandbox marker', `echo "${MARKER}" >&2\nexit 78`],
    ['without the marker', 'echo "probe: cannot reach service" >&2\nexit 78'],
  ])('an exit 78 %s is an inconclusive environment failure', async (_label, body) => {
    const { res, messages } = await health(body);
    expect(res.kind).toBe('inconclusive');
    expect(res.failingChecks).toEqual([]);
    expect(res.evidence).toEqual([expect.objectContaining({ checker: 'tests', cause: 'environment', exitCode: 78 })]);
    expect(messages.join('\n')).toMatch(/tests: environment error \(exit 78\)/);
  });

  it('a missing command (exit 127) is inconclusive with the shell error in the tail', async () => {
    const { res, messages } = await health('definitely-not-a-real-tool-xyz --run');
    expect(res.kind).toBe('inconclusive');
    expect(res.evidence).toEqual([
      expect.objectContaining({
        checker: 'tests',
        cause: 'missing-command',
        exitCode: 127,
        tail: expect.stringContaining('command not found'),
      }),
    ]);
    expect(messages.join('\n')).toMatch(/command not found/);
  });

  it('never caches an inconclusive base result', async () => {
    const dir = await tempDirs.make('base-health-cache-');
    const cachePath = join(dir, 'baseline-cache.json');
    await health('definitely-not-a-real-tool-xyz', { cachePath });
    const stored = await readFile(cachePath, 'utf8').catch(() => '{"entries":{}}');
    expect(Object.keys(JSON.parse(stored).entries).filter((k) => k.endsWith(':tests'))).toEqual([]);
  });
});

describe('checkBaseHealth: a genuine test failure stays red with bounded evidence', () => {
  it('red on tests, with the failing test line, command and exit code', async () => {
    const { res, messages } = await health(
      'echo " FAIL  src/math.test.ts > add > adds"\necho "AssertionError: expected 3 to be 4" >&2\nexit 1',
    );
    expect(res.kind).toBe('red');
    expect(res.failingChecks).toEqual(['tests']);
    expect(res.evidence).toEqual([
      {
        checker: 'tests',
        command: 'bash scripts/verify.sh --no-e2e',
        exitCode: 1,
        timeoutSeconds: 1,
        tail: expect.stringContaining('FAIL  src/math.test.ts > add > adds'),
      },
    ]);
    expect(messages.join('\n')).toMatch(/is red \(tests\)/);
  });

  it('bounds the evidence tail for a very large failure output', async () => {
    const { res } = await health('head -c 50000 /dev/zero | tr "\\0" x >&2\nexit 1');
    expect(res.kind).toBe('red');
    expect(res.evidence?.[0]?.tail.length).toBeLessThanOrEqual(501);
  });

  it('a passing verify.sh is green (control)', async () => {
    const { res } = await health('echo ok');
    expect(res.kind).toBe('green');
  });
});
