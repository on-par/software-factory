import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { LaneEnvironmentPauseError, type CliDeps } from './index.js';
import {
  coreFakes,
  daemonDeps,
  errored,
  h,
  inertConfigLoaders,
  installCliCommandsHarness,
  logged,
  logSpy,
  paths,
  phases,
  recordingRunTui,
  runMain,
  runMainRaw,
  runMainWith,
  tmp,
  shipIssue,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('models', () => {
    it('uses an injected loadModelsConfig instead of the factory-core loader', async () => {
      const config = { models: { 'distinctive-model-2063': {} }, tiers: {} };
      const stub = vi.fn(() => config as never);

      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, loadModelsConfig: stub }, 'models');

      expect(stub).toHaveBeenCalled();
      expect(coreFakes.ModelRegistry.mock.calls.at(-1)?.[0]).toMatchObject({
        models: { 'distinctive-model-2063': {} },
      });
    });

    it('uses the factory-core loadModelsConfig when none is injected', async () => {
      await runMainRaw({ daemon: daemonDeps(), runTui: recordingRunTui }, 'models');
      const arg = coreFakes.ModelRegistry.mock.calls.at(-1)?.[0] as { models: object };
      expect(Object.keys(arg.models).length).toBeGreaterThan(0);
    });

    it('restores the default loaders after main() returns', async () => {
      const stub = vi.fn((repoRoot: string, stateRoot?: string) => FactoryCore.loadRepoConfig(repoRoot, stateRoot));
      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, loadRepoConfig: stub as never }, 'models');
      const stubCalls = stub.mock.calls.length;

      await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo });

      expect(stub.mock.calls.length).toBe(stubCalls);
    });

    it('restores the default phases after main() returns', async () => {
      const stub = vi.fn(async () => h.planResult) as never;
      await runMainWith({ daemon: daemonDeps(), runTui: recordingRunTui, planPhase: stub }, 'models');

      await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo });

      expect(stub).not.toHaveBeenCalled();
      expect(phases.planPhase).toHaveBeenCalled();
    });

    it('serves the run from the offline GitHub stub when FACTORY_GITHUB=stub (#2652)', async () => {
      const stubDir = tmp.makeSync('factory-gh-stub-');
      try {
        writeFileSync(
          join(stubDir, 'fixture.json'),
          JSON.stringify({ issues: { '5': { title: 'Stubbed title', body: 'b' } } }),
        );
        vi.stubEnv('FACTORY_GITHUB', 'stub');
        vi.stubEnv('FACTORY_GITHUB_STUB_DIR', stubDir);
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await shipIssue(5, { sizeGate: 'off' }, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }, { octokit: undefined });

        const plan = phases.planPhase.mock.calls.at(-1)?.[0] as any;
        expect(plan.branch).toBe('factory/5-stubbed-title'); // slug of the fixture title
        const captured = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
        await captured.octokit.rest.pulls.create({ head: captured.branch, title: 't', base: 'main' });
        // The wrapper delegates to the real runner; only a harmless non-push command is run here.
        await expect(captured.run('echo stub')).resolves.toMatchObject({ stdout: 'stub\n' });
        const ops = readFileSync(join(stubDir, 'calls.jsonl'), 'utf-8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l).op);
        expect(ops).toContain('pulls.create');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        rmSync(stubDir, { recursive: true, force: true });
      }
    });

    it('red base from the pre-PLAN health check throws LaneEnvironmentPauseError before planPhase', async () => {
      const baseSha = 'a'.repeat(40);
      const red = vi.fn<NonNullable<CliDeps['checkBaseHealth']>>(async () => ({
        kind: 'red' as const,
        baseSha,
        failingChecks: ['tests'],
        cached: false,
      }));

      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }, { checkBaseHealth: red }).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(LaneEnvironmentPauseError);
      expect((err as LaneEnvironmentPauseError).baseSha).toBe(baseSha);
      expect((err as LaneEnvironmentPauseError).failingChecks).toEqual(['tests']);
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('a .factory/config template token parks the run before planPhase with file:line', async () => {
      mkdirSync(dirname(paths().config), { recursive: true });
      writeFileSync(paths().config, '{\n  "version": 2,\n  "models": { "pins": { "build": "<owner-name>" } }\n}\n');

      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch((e: unknown) => e);

      expect((err as Error).message).toContain(
        `${relative(h.repoRoot, paths().config)}:3: unfilled template token '<owner-name>'`,
      );
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('routes constitution --product through an injected getConstitutionsDir', async () => {
      writeFileSync(join(h.constitutionsDir, 'alpha.md'), '# alpha');
      const stub = vi.fn(() => h.constitutionsDir);
      await runMainWith(
        { daemon: daemonDeps(), runTui: recordingRunTui, getConstitutionsDir: stub },
        'constitution',
        '--product',
        'alpha',
      );
      expect(stub).toHaveBeenCalled();
      expect(inertConfigLoaders.getConstitutionsDir).not.toHaveBeenCalled();
    });

    it('lists models, costs, and tiers', async () => {
      await runMain('models');
      const out = logged();
      expect(out).toContain('Available Models');
      expect(out).toContain('claude-model');
      expect(out).toContain('Tiers');
      expect(out).toContain('boss:');
    });

    describe('with the real registry and diagnoseModels (#2402)', () => {
      const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
      const saved = { base: process.env.OLLAMA_BASE_URL, localOnly: process.env.FACTORY_LOCAL_ONLY };
      let captured: InstanceType<typeof FactoryCore.ModelRegistry> | undefined;

      beforeEach(() => {
        delete process.env.OLLAMA_BASE_URL;
        delete process.env.FACTORY_LOCAL_ONLY;
        captured = undefined;
        h.execSyncImpl = () => {
          throw new Error('ollama: command not found');
        };
      });

      afterEach(() => {
        if (saved.base === undefined) delete process.env.OLLAMA_BASE_URL;
        else process.env.OLLAMA_BASE_URL = saved.base;
        if (saved.localOnly === undefined) delete process.env.FACTORY_LOCAL_ONLY;
        else process.env.FACTORY_LOCAL_ONLY = saved.localOnly;
      });

      function realDeps(): CliDeps {
        return {
          daemon: daemonDeps(),
          runTui: recordingRunTui,
          ModelRegistry: vi.fn(function (cfg: never) {
            captured = new FactoryCore.ModelRegistry(cfg);
            return captured;
          }) as never,
          diagnoseModels: FactoryCore.diagnoseModels,
        };
      }

      function iconsByModel(out: string, suffix: string): Map<string, string> {
        const map = new Map<string, string>();
        for (const line of out.replace(ANSI, '').split('\n')) {
          const match = line.match(new RegExp(`^\\s*(✅|⚠️|❌) (\\S+) ${suffix}`));
          if (match) map.set(match[2], match[1]);
        }
        return map;
      }

      it('marks every ollama-provider model ❌ without running `ollama list` when ollama is not on PATH (#2724)', async () => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) => c !== 'ollama');
        const cmds: string[] = [];
        h.execSyncImpl = (cmd: string) => (cmds.push(cmd), '/bin/sh: 1: ollama: not found');
        for (const args of [['models'], ['models', '--doctor']]) await runMainRaw(realDeps(), ...args);
        process.exitCode = undefined;
        expect(cmds).not.toContain('ollama list');
        expect(logged() + errored()).not.toMatch(/\/bin\/sh|ollama: not found/);
        const ollamaModels = captured!.list().filter((m) => captured!.get(m)?.provider === 'ollama');
        expect(ollamaModels.length).toBeGreaterThan(0);
        const lines = logged().replace(ANSI, '').split('\n');
        for (const m of ollamaModels) {
          expect(lines.some((l) => l.includes(`❌ ${m} tier=`))).toBe(true);
          expect(lines.some((l) => l.includes(`✅ ${m} tier=`))).toBe(false);
        }
      });

      it('plain list and --doctor show the same status per model', async () => {
        coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'claude');

        await runMainRaw(realDeps(), 'models');
        const plain = iconsByModel(logged(), 'tier=');
        logSpy.mockClear();
        await runMainRaw(realDeps(), 'models', '--doctor');
        const doctor = iconsByModel(logged(), 'provider=');
        process.exitCode = undefined;

        expect(plain.size).toBeGreaterThan(0);
        expect([...plain.keys()].sort()).toEqual([...doctor.keys()].sort());
        for (const [model, icon] of plain) expect(doctor.get(model)).toBe(icon);
      });

      describe('repo-defined models (#2443)', () => {
        const writeRepoModel = () => {
          mkdirSync(paths().root, { recursive: true });
          writeFileSync(
            paths().config,
            JSON.stringify({
              version: 2,
              models: {
                registry: {
                  'my-opencode-model': {
                    provider: 'custom',
                    tier: 'worker',
                    costPerMtokInput: 1,
                    costPerMtokOutput: 2,
                    contextWindow: 1000,
                    capabilities: [],
                    envKey: null,
                    providerModel: 'my-opencode-model',
                    harness: 'opencode',
                  },
                },
              },
            }),
          );
        };

        afterEach(() => {
          rmSync(paths().config, { force: true });
        });

        it('marks a models.registry model as repo-defined in factory models', async () => {
          writeRepoModel();
          await runMainRaw(realDeps(), 'models');
          const lines = logged().replace(ANSI, '').split('\n');
          expect(lines.find((l) => l.includes('my-opencode-model tier='))).toContain('[repo-defined]');
          for (const m of captured!.list().filter((id) => id !== 'my-opencode-model')) {
            const row = lines.find((l) => l.includes(` ${m} tier=`));
            expect(row).toBeDefined();
            expect(row).not.toContain('[repo-defined]');
          }
        });

        it('marks a models.registry model as repo-defined in factory models --doctor', async () => {
          writeRepoModel();
          await runMainRaw(realDeps(), 'models', '--doctor');
          process.exitCode = undefined;
          const lines = logged().replace(ANSI, '').split('\n');
          expect(lines.find((l) => l.includes('my-opencode-model provider='))).toContain('[repo-defined]');
          expect(lines.filter((l) => l.includes('[repo-defined]'))).toHaveLength(1);
        });
      });
    });

    it('doctor prints the report and returns when a worker is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Model Doctor');
    });

    it('doctor exits 1 when no worker is reachable', async () => {
      h.diagnoses = [
        { model: 'b', provider: 'anthropic', tiers: ['boss'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const res = await runMain('models', '--doctor');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no worker model is reachable');
    });
  });
});
