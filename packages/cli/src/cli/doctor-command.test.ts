// packages/cli/src/cli/doctor-command.test.ts — factory doctor dispatch tests, moved from cli-commands.test.ts (#2799)

import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HARNESS_SETUP } from './doctor-harness.js';
import { coreFakes, h, installDoctorHarness, logged, ops, paths, runMainWith } from './test-support/doctor-harness.js';

installDoctorHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

const resetDoctorAuthEnvironment = (): void => {
  const home = join(h.repoRoot, 'test-home');
  const codexHome = join(h.repoRoot, 'no-codex-home');
  const claudeConfig = join(h.repoRoot, 'no-claude-config');
  const xdgData = join(h.repoRoot, 'no-xdg-data');
  for (const directory of [home, codexHome, claudeConfig, xdgData]) mkdirSync(directory, { recursive: true });
  vi.stubEnv('HOME', home);
  vi.stubEnv('CODEX_HOME', codexHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeConfig);
  vi.stubEnv('XDG_DATA_HOME', xdgData);
  for (const key of new Set(HARNESS_SETUP.flatMap(({ envKeys }) => envKeys))) vi.stubEnv(key, '');
};

describe('cli', () => {
  describe('doctor', () => {
    beforeEach(() => {
      resetDoctorAuthEnvironment();
      // Green doctor tests need at least one signed-in agent (#2556); agent sign-in cases override via withAuth.
      writeFileSync(join(h.repoRoot, 'no-claude-config', '.credentials.json'), '{}');
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('git config user.name')) return 'Test User';
        if (cmd.includes('git config user.email')) return 'test@example.com';
        if (cmd.includes('gh auth token')) return 'gho_token';
        if (cmd.includes('gh auth status')) return 'Logged in';
        return '';
      };
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    describe('repo-configured command harness (#2691)', () => {
      const setup = (agentOnPath: boolean) => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) =>
          c === 'my-agent' ? agentOnPath : !['claude', 'codex', 'opencode', 'pi'].includes(c),
        );
        mkdirSync(paths().root, { recursive: true });
        writeFileSync(
          paths().config,
          JSON.stringify({
            version: 2,
            models: {
              registry: {
                'my-model': {
                  provider: 'custom',
                  tier: 'worker',
                  costPerMtokInput: 1,
                  costPerMtokOutput: 2,
                  contextWindow: 1000,
                  capabilities: [],
                  envKey: null,
                  providerModel: 'my-model',
                  harness: 'my-agent',
                },
              },
            },
          }),
        );
        return runMainWith(
          {
            loadModelsConfig: () =>
              ({
                models: {},
                tiers: {},
                harnesses: {
                  'my-agent': {
                    command: 'my-agent --model {model}',
                    prompt: 'stdin',
                    output: 'stdout',
                    agentic: true,
                    usage: 'none',
                  },
                },
              }) as never,
            loadRepoConfig: (root: string) => JSON.parse(readFileSync(join(root, '.factory', 'config.json'), 'utf-8')),
          },
          'doctor',
        );
      };

      afterEach(() => {
        rmSync(paths().config, { force: true });
      });

      it('passes with only a repo-configured command harness on PATH (#2691)', async () => {
        const res = await setup(true);
        expect(res.exited).toBe(false);
        expect(logged()).toContain('my-agent (command harness)');
      });

      it('fails and names the configured command when the executable is missing', async () => {
        const res = await setup(false);
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('my-agent --model {model}');
      });
    });

    describe('repo-declared harness (#2870)', () => {
      const agent = { command: 'my-agent --headless', prompt: 'stdin', output: 'stdout', agentic: true, usage: 'none' };
      const setup = (harnessId: string, agentOnPath: boolean, usedHarness = 'my-agent') => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) =>
          c === 'my-agent' ? agentOnPath : !['claude', 'codex', 'opencode', 'pi'].includes(c),
        );
        mkdirSync(paths().root, { recursive: true });
        writeFileSync(
          paths().config,
          JSON.stringify({
            version: 2,
            harnesses: { [harnessId]: agent },
            models: {
              registry: {
                'my-model': {
                  provider: 'custom',
                  tier: 'worker',
                  costPerMtokInput: 1,
                  costPerMtokOutput: 2,
                  contextWindow: 1000,
                  capabilities: [],
                  envKey: null,
                  providerModel: 'my-model',
                  harness: usedHarness,
                },
              },
            },
          }),
        );
        return runMainWith(
          {
            loadModelsConfig: () => ({ models: {}, tiers: {}, harnesses: {} }) as never,
            loadRepoConfig: (root: string) => JSON.parse(readFileSync(join(root, '.factory', 'config.json'), 'utf-8')),
          },
          'doctor',
        );
      };

      afterEach(() => {
        rmSync(paths().config, { force: true });
      });

      it('counts a harness declared in the repo config as the coding agent', async () => {
        const res = await setup('my-agent', true);
        expect(res.exited).toBe(false);
        expect(logged()).toContain('my-agent (command harness)');
      });

      it('accepts the repo-declared id in the models.registry check', async () => {
        await setup('my-agent', true);
        expect(logged()).not.toContain('unknown harness');
        expect(logged()).not.toContain('is not a known harness');
      });

      it('names harnesses.my-agent.command in .factory/config.yaml when the executable is missing', async () => {
        const res = await setup('my-agent', false);
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('harnesses.my-agent.command in .factory/config.yaml');
      });

      it('reports a redeclared built-in harness once and keeps going', async () => {
        h.claudeAvailable = true;
        const res = await setup('claude-cli', true, 'claude-cli');
        expect(res.exited).toBeTruthy();
        expect(logged().split("Harness 'claude-cli' is built in").length - 1).toBe(1);
      });
    });

    describe('agent sign-in (#2496)', () => {
      const withAuth = (claudeOk: boolean, codexOk: boolean) => {
        // Claude sign-in comes from local evidence (#2556), never from `claude -p`.
        const credPath = join(h.repoRoot, 'no-claude-config', '.credentials.json');
        if (claudeOk) writeFileSync(credPath, '{}');
        else if (existsSync(credPath)) unlinkSync(credPath);
        const base = h.execSyncImpl;
        h.execSyncImpl = (cmd: string) => {
          if (cmd.includes('find-generic-password')) {
            if (!claudeOk) throw new Error('not found');
            return '';
          }
          if (cmd.startsWith('codex login status')) return codexOk ? 'Logged in using ChatGPT' : 'Not logged in';
          return base(cmd);
        };
      };

      it('passes with a warning when claude is logged out but codex is signed in', async () => {
        h.claudeAvailable = true;
        withAuth(false, true);
        const res = await runMain('doctor');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('another agent is signed in');
      });

      it('logged-out sign-in result ignores agent credentials in the shell and the real home', async () => {
        const hostHome = join(h.repoRoot, 'host-home');
        const hostClaudeConfig = join(hostHome, '.claude');
        const hostCred = join(hostClaudeConfig, '.credentials.json'),
          hostFailures = join(hostHome, '.factory', 'auth', 'local-auth-failures.json');
        mkdirSync(hostClaudeConfig, { recursive: true });
        mkdirSync(join(hostHome, '.factory', 'auth'), { recursive: true });
        const oauth = { accessToken: 'dummy', refreshToken: 'dummy-r', expiresAt: Date.now() + 3_600_000 };
        writeFileSync(hostCred, JSON.stringify({ claudeAiOauth: oauth }));
        utimesSync(hostCred, (Date.now() - 3_600_000) / 1000, (Date.now() - 3_600_000) / 1000);
        const failureAt = new Date().toISOString();
        writeFileSync(hostFailures, JSON.stringify({ claude: { agent: 'claude', at: failureAt } }));
        vi.stubEnv('HOME', hostHome);
        vi.stubEnv('CLAUDE_CONFIG_DIR', hostClaudeConfig);
        vi.stubEnv('CODEX_HOME', join(hostHome, '.codex'));
        vi.stubEnv('XDG_DATA_HOME', join(hostHome, '.local', 'share'));
        for (const key of new Set(HARNESS_SETUP.flatMap(({ envKeys }) => envKeys)))
          vi.stubEnv(key, 'dummy-host-credential');

        resetDoctorAuthEnvironment();
        h.claudeAvailable = true;
        withAuth(false, false);
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('claude signed in - unverified: no sign-in evidence');
        expect(logged()).not.toContain('another agent is signed in');
        expect(logged()).not.toContain(failureAt);
        expect(process.env.HOME).toBe(join(h.repoRoot, 'test-home'));
        expect(existsSync(join(h.repoRoot, 'test-home', '.factory', 'auth', 'local-auth-failures.json'))).toBe(false);
        expect(existsSync(hostCred) && existsSync(hostFailures)).toBe(true);
      });

      const writeCodexHome = (name: string, tokens: Record<string, string>) => {
        const codexHome = join(h.repoRoot, name);
        mkdirSync(codexHome, { recursive: true });
        writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens }));
        vi.stubEnv('CODEX_HOME', codexHome);
      };
      const expiredJwt = () =>
        `h.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 3600 })).toString('base64url')}.s`;

      it('passes codex auth for an expired access token with a refresh token (#2509)', async () => {
        h.claudeAvailable = true;
        withAuth(false, true);
        writeCodexHome('refreshable-codex-home', { access_token: expiredJwt(), refresh_token: 'dummy' });
        const res = await runMain('doctor');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('codex refreshes it on the next run');
      });

      it('fails when codex holds an unusable ChatGPT session and claude is logged out (#2509)', async () => {
        h.claudeAvailable = true;
        withAuth(false, true);
        writeCodexHome('unusable-codex-home', { access_token: expiredJwt() });
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('ChatGPT session in auth.json is unusable');
      });

      const writeClaudeCreds = (oauth: Record<string, unknown>) =>
        writeFileSync(
          join(h.repoRoot, 'no-claude-config', '.credentials.json'),
          JSON.stringify({ claudeAiOauth: oauth }),
        );

      it('fails when the stored Claude login expired with no refresh token and no other agent is signed in (#2721)', async () => {
        h.claudeAvailable = true;
        withAuth(false, false);
        writeClaudeCreds({ accessToken: 'dummy', expiresAt: Date.now() - 3_600_000 });
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('re-run claude login');
        expect(logged()).not.toContain('dummy');
      });

      it('keeps claude signed in for an expired access token with a refresh token (#2721)', async () => {
        h.claudeAvailable = true;
        withAuth(false, false);
        writeClaudeCreds({ accessToken: 'dummy', refreshToken: 'dummy-r', expiresAt: Date.now() - 3_600_000 });
        const res = await runMain('doctor');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('signed in (stored Claude Code login found)');
      });

      it('fails claude when its last run hit local_auth after the last login, and a new login clears it (#2733)', async () => {
        h.claudeAvailable = true;
        withAuth(false, false);
        const home = join(h.repoRoot, 'test-home');
        const cred = join(h.repoRoot, 'no-claude-config', '.credentials.json');
        writeClaudeCreds({ accessToken: 'dummy', refreshToken: 'dummy-r', expiresAt: Date.now() + 3_600_000 });
        const loginAt = (Date.now() - 3_600_000) / 1000;
        utimesSync(cred, loginAt, loginAt);
        mkdirSync(join(home, '.factory', 'auth'), { recursive: true });
        writeFileSync(
          join(home, '.factory', 'auth', 'local-auth-failures.json'),
          JSON.stringify({ claude: { agent: 'claude', at: new Date(Date.now() - 60_000).toISOString() } }),
        );
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('re-run claude login');
        expect(logged()).not.toContain('dummy');

        const relogin = Date.now() / 1000;
        utimesSync(cred, relogin, relogin);
        const again = await runMain('doctor');
        expect(again.exited).toBe(false);
      });

      it('fails when every installed agent is logged out', async () => {
        h.claudeAvailable = true;
        withAuth(false, false);
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
      });
    });

    describe('harness sign-in (#2556)', () => {
      const INFERENCE = /^(claude\s+(-p|--print)|codex\s+exec|opencode\s+run)\b/;

      it('never runs an inference command for any of the three harnesses', async () => {
        h.claudeAvailable = true;
        const recorded: string[] = [];
        const base = h.execSyncImpl;
        h.execSyncImpl = (cmd: string) => {
          recorded.push(cmd);
          return base(cmd);
        };
        await runMain('doctor');
        expect(recorded.filter((c) => INFERENCE.test(c))).toEqual([]);
        expect(logged()).toContain('claude signed in');
        expect(logged()).not.toContain('claude auth (host)');
      });

      it('runs the claude -p probe only with --probe-inference', async () => {
        h.claudeAvailable = true;
        const recorded: string[] = [];
        const base = h.execSyncImpl;
        h.execSyncImpl = (cmd: string) => {
          recorded.push(cmd);
          return base(cmd);
        };
        await runMain('doctor', '--probe-inference');
        expect(recorded.some((c) => c.startsWith('claude -p'))).toBe(true);
        expect(logged()).toContain('claude auth (host)');
      });
    });

    it('prints the report and does not exit when the environment is all green', async () => {
      h.claudeAvailable = true;
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('== factory doctor ==');
    });

    describe('models.registry', () => {
      const writeRegistry = (harness?: string) => {
        mkdirSync(paths().root, { recursive: true });
        writeFileSync(
          paths().config,
          JSON.stringify({
            version: 2,
            models: {
              registry: {
                'my-model': {
                  provider: 'custom',
                  tier: 'worker',
                  costPerMtokInput: 1,
                  costPerMtokOutput: 2,
                  contextWindow: 1000,
                  capabilities: [],
                  envKey: null,
                  providerModel: 'my-model',
                  ...(harness === undefined ? {} : { harness }),
                },
              },
            },
          }),
        );
      };

      it('fails and names the config path and harness field for a models.registry entry with no harness', async () => {
        h.claudeAvailable = true;
        writeRegistry();
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('.factory/config.json');
        expect(logged()).toContain('models.registry.my-model.harness');
      });

      it('fails and names the config path and harness field for a models.registry entry with an unknown harness', async () => {
        h.claudeAvailable = true;
        writeRegistry('nope');
        const res = await runMain('doctor');
        expect(res.exited).toBeTruthy();
        expect(logged()).toContain('.factory/config.json');
        expect(logged()).toContain('models.registry.my-model.harness');
      });
    });

    it('reports a declared harness whose probe passes as available', async () => {
      h.claudeAvailable = true;
      h.harnessProbes = [{ harness: 'my-agent', probe: 'my-agent --version', status: 'available', detail: '' }];
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('harness my-agent - available (probe: my-agent --version)');
    });

    it('reports a declared harness without a probe as unverified without failing doctor', async () => {
      h.claudeAvailable = true;
      h.harnessProbes = [{ harness: 'my-agent', status: 'unverified', detail: '' }];
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('unverified: no probe configured');
    });

    it('probes the sandbox runtime through the injected execSync seam, not node:child_process (#2014)', async () => {
      h.claudeAvailable = true;
      const base = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('command -v sandbox-exec') || cmd.includes('command -v firejail')) {
          throw new Error('not on PATH');
        }
        return base(cmd);
      };
      const res = await runMain('doctor', '--probe-inference');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped: no sandbox runtime (sandbox-exec/firejail) on this host');
      expect(ops.execSync).toHaveBeenCalledWith(
        expect.stringMatching(/^command -v (sandbox-exec|firejail) /),
        expect.anything(),
      );
    });

    it('skips the sandboxed claude probe when sandbox is disabled by config', async () => {
      h.claudeAvailable = true;
      h.factoryConfig = { ...h.factoryConfig, sandbox: { ...h.factoryConfig.sandbox, enabled: false } };
      const res = await runMain('doctor', '--probe-inference');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped: sandbox disabled by config or FACTORY_SANDBOX');
    });

    it('reports .factory/state/STOP not present when the sentinel is absent', async () => {
      h.claudeAvailable = true;
      rmSync(paths().stop, { force: true });
      await runMain('doctor');
      expect(logged()).toContain('.factory/state/STOP not present');
      expect(logged()).not.toContain('.factory/STOP');
    });

    it('reports .factory/state/STOP presence as an explicit, non-failing row', async () => {
      h.claudeAvailable = true;
      writeFileSync(paths().stop, '');
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('STOP sentinel');
      expect(logged()).toContain('.factory/state/STOP present');
      expect(logged()).not.toContain('.factory/STOP');
    });

    it('exits 0 outside a git repo and prints the cd hint', async () => {
      h.claudeAvailable = true;
      const base = h.execSyncImpl;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) throw new Error('not a git repository');
        return base(cmd);
      };
      const res = await runMain('doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('cd into your repo, then run factory doctor again');
    });

    it('exits 1 when claude is unavailable', async () => {
      h.claudeAvailable = false;
      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
    });

    it('exits 1 and reports auth failure when an execSync probe throws', async () => {
      h.claudeAvailable = true;
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('status --porcelain')) return '';
        if (cmd.includes('git config user.name')) return 'Test User';
        if (cmd.includes('git config user.email')) return 'test@example.com';
        if (cmd.includes('gh auth token')) return 'gho_token';
        if (cmd.includes('gh auth status')) throw new Error('not logged in');
        return '';
      };
      const res = await runMain('doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('gh is not authenticated');
    });
  });
});
