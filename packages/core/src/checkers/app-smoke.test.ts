import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { QaConfig } from '../config/qa-section.js';
import { defaultIsProcessGroupAlive, killProcessGroup } from '../environment/process-groups.js';
import { ModelRouter } from '../router/index.js';
import { StubModelExecutor } from '../router/stub.js';
import type { Constitution } from '../types/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { appSmokeChecker, defaultStartApp, type AppSmokeDeps, type StartedApp } from './app-smoke.js';
import { runAllCheckers, type CheckerContext } from './index.js';

const never = new Promise<never>(() => {});

function qa(over: Partial<QaConfig> = {}): QaConfig {
  return { start: ['node', '-e', 'process.exit(1)'], smoke: ['true'], readyPath: '/', readyTimeoutSeconds: 5, ...over };
}

function ctxOf(over: Partial<CheckerContext> = {}): CheckerContext {
  return { worktree: tmpdir(), specPath: 'none', env: { PORT: '45123' }, qa: qa(), ...over };
}

function fakeApp(
  exitCode: number | null,
  output = 'boom',
): (a: readonly string[], o: { onPgid?: (p: number) => void }) => StartedApp {
  return (_argv, o) => {
    o.onPgid?.(4242);
    return {
      pid: 4242,
      exited: exitCode === null ? never : Promise.resolve({ code: exitCode, signal: null }),
      output: () => output,
    };
  };
}

function result(over: Partial<CommandResult>): CommandResult {
  return { command: ['x'], stdout: '', stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true, ...over };
}

describe('appSmokeChecker', () => {
  it('app_smoke fails when the built app never becomes ready on the lane port', async () => {
    const killGroup = vi.fn(async () => {});
    const onPgid = vi.fn();
    const out = await appSmokeChecker(ctxOf({ onPgid }), {
      startApp: fakeApp(1),
      probeReady: async () => null,
      killGroup,
    });
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('start exited (code 1)');
    expect(out.details).toContain('boom');
    expect(killGroup).toHaveBeenCalledWith(4242);
    expect(onPgid).toHaveBeenCalledWith(4242);
  });

  it('fails with "not ready after Ns" when nothing answers below 500', async () => {
    let t = 0;
    const killGroup = vi.fn(async () => {});
    const out = await appSmokeChecker(ctxOf(), {
      startApp: fakeApp(null),
      probeReady: async () => 503,
      killGroup,
      now: () => t,
      sleep: async (ms) => {
        t += ms * 4;
      },
    });
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('not ready after 5s');
    expect(killGroup).toHaveBeenCalledWith(4242);
  });

  it('app_smoke fails with smoke exit code and writes both command logs', async () => {
    const outputLogDir = await mkdtemp(join(tmpdir(), 'app-smoke-logs-'));
    const out = await appSmokeChecker(
      ctxOf({ outputLogDir, runCommand: async () => result({ exitCode: 3, ok: false, stderr: 'smoke broke' }) }),
      { startApp: fakeApp(null, 'server log'), probeReady: async () => 200, killGroup: async () => {} },
    );
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('smoke exit 3');
    expect(out.details).toContain('smoke broke');
    expect((await readdir(outputLogDir)).sort()).toEqual(['app-smoke-smoke.log', 'app-smoke-start.log']);
  });

  it('passes and kills the group when smoke succeeds', async () => {
    const killGroup = vi.fn(async () => {});
    const out = await appSmokeChecker(ctxOf({ runCommand: async () => result({}) }), {
      startApp: fakeApp(null),
      probeReady: async () => 404,
      killGroup,
    });
    expect(out.result).toBe('PASS');
    expect(killGroup).toHaveBeenCalledWith(4242);
  });

  it('still kills the group when the probe throws', async () => {
    const killGroup = vi.fn(async () => {});
    await expect(
      appSmokeChecker(ctxOf(), {
        startApp: fakeApp(null),
        probeReady: async () => {
          throw new Error('probe blew up');
        },
        killGroup,
      }),
    ).rejects.toThrow('probe blew up');
    expect(killGroup).toHaveBeenCalledWith(4242);
  });

  it('skips without starting the app when qa or the lane port is missing', async () => {
    const startApp = vi.fn(fakeApp(null));
    const deps: Partial<AppSmokeDeps> = { startApp };
    const noQa = await appSmokeChecker(ctxOf({ qa: null }), deps);
    const noSmoke = await appSmokeChecker(ctxOf({ qa: qa({ smoke: undefined }) }), deps);
    const noPort = await appSmokeChecker(ctxOf({ env: {} }), deps);
    const badPort = await appSmokeChecker(ctxOf({ env: { PORT: 'abc' } }), deps);
    expect([noQa, noSmoke].map((o) => [o.result, o.details])).toEqual([
      ['SKIP', 'no qa.start/qa.smoke in .factory/config.json'],
      ['SKIP', 'no qa.start/qa.smoke in .factory/config.json'],
    ]);
    for (const o of [noPort, badPort]) {
      expect(o.result).toBe('SKIP');
      expect(o.details.startsWith('unavailable')).toBe(true);
    }
    expect(startApp).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid .factory/config.json', async () => {
    const worktree = await mkdtemp(join(tmpdir(), 'app-smoke-wt-'));
    await mkdir(join(worktree, '.factory'), { recursive: true });
    await writeFile(join(worktree, '.factory', 'config.json'), JSON.stringify({ version: 2, qa: { bogus: 1 } }));
    const { qa: _qa, ...rest } = ctxOf({ worktree });
    const out = await appSmokeChecker(rest);
    expect(out.result).toBe('FAIL');
    expect(out.details).toContain('invalid .factory/config.json');
  });

  it.skipIf(process.platform === 'win32')(
    'app_smoke passes against a real localhost server and kills its process group',
    async () => {
      const port = await new Promise<number>((resolve) => {
        const s = createServer();
        s.listen(0, '127.0.0.1', () => {
          const p = (s.address() as { port: number }).port;
          s.close(() => resolve(p));
        });
      });
      let pgid: number | undefined;
      let host: string | undefined;
      const killed: number[] = [];
      const out = await appSmokeChecker(
        ctxOf({
          env: { PORT: String(port) },
          qa: qa({
            start: [
              'node',
              '-e',
              "require('http').createServer((q,s)=>s.end('ok')).listen(+process.env.PORT, process.env.HOST)",
            ],
            smoke: ['node', '-e', 'process.exit(0)'],
          }),
        }),
        {
          startApp: (argv, o) => {
            host = o.env.HOST;
            return defaultStartApp(argv, {
              ...o,
              onPgid: (p) => {
                pgid = p;
                o.onPgid?.(p);
              },
            });
          },
          killGroup: async (p) => {
            killed.push(p);
            return killProcessGroup(p, { graceMs: 500 });
          },
        },
      );
      expect(out.result).toBe('PASS');
      expect(host).toBe('127.0.0.1');
      expect(killed).toEqual([pgid]);
      expect(defaultIsProcessGroupAlive(pgid as number)).toBe(false);
    },
    30000,
  );
});

const models: ModelsConfig = {
  version: 1,
  models: {
    'stub-model': {
      provider: 'custom',
      tier: 'boss',
      costPerMtokInput: 0,
      costPerMtokOutput: 0,
      contextWindow: 1000,
      capabilities: [],
      envKey: null,
    },
  },
  tiers: { boss: ['stub-model'] },
  failover: { triggers: ['error'], maxRetries: 1, cooldownMs: 0, escalateAfterTierExhausted: true },
  routingRules: {},
};
const routes: RoutesConfig = { version: 1, routes: { check_custom: { tier: 'boss', description: 'stub' } } };

function constitutionWith(checkers: string[]): Constitution {
  return { product: 'p', version: 1, checkers, body: '', path: 'p.md', source: 'bundled' };
}

describe('app_smoke registry opt-in', () => {
  it('app_smoke is opt-in and skips without a qa block or leased port', { timeout: 60000 }, async () => {
    const router = new ModelRouter(models, routes, false, new StubModelExecutor({ scripts: {} }));
    const worktree = await mkdtemp(join(tmpdir(), 'app-smoke-reg-'));
    const ctx = ctxOf({ worktree, qa: null });
    const names = async (c: Constitution | null) =>
      (await runAllCheckers(ctx, router, c)).results.map((r) => r.checker);
    expect(await names(null)).not.toContain('app_smoke');
    expect(await names(constitutionWith(['compile']))).not.toContain('app_smoke');
    const declared = await runAllCheckers(ctx, router, constitutionWith(['app_smoke']));
    const smoke = declared.results.find((r) => r.checker === 'app_smoke');
    expect(smoke).toMatchObject({ result: 'SKIP', details: 'no qa.start/qa.smoke in .factory/config.json' });
    const noPort = await runAllCheckers({ ...ctx, qa: qa(), env: {} }, router, constitutionWith(['app_smoke']));
    expect(noPort.results.find((r) => r.checker === 'app_smoke')?.details).toMatch(/^unavailable/);
  });
});
