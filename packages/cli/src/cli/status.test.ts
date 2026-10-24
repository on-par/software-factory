// packages/cli/src/cli/status.test.ts — factory status tests, moved from cli-commands.test.ts (#2798)

import { workKeyFromIssue } from '@on-par/factory-core';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coreFakes, errored, h, installShipHarness, logged, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('cli', () => {
  describe('status', () => {
    it('status exits 2 with gh auth login guidance when gh is not authenticated (#2592)', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) {
          throw Object.assign(new Error('Command failed: gh repo view'), {
            stderr:
              'To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n',
          });
        }
        return '';
      };
      const res = await runMain('status');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('gh is not authenticated');
      expect(errored()).toContain('gh auth login');
      expect(errored()).not.toContain('no GitHub remote detected');
    });

    it('status exits 2 saying the token was rejected and naming the repo scope when gh reports bad credentials (#2593)', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) {
          throw Object.assign(new Error('Command failed: gh repo view'), {
            stderr:
              'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login\n',
          });
        }
        return '';
      };
      const res = await runMain('status');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('rejected the token');
      expect(errored()).toContain('`repo` scope');
      expect(errored()).not.toContain('no GitHub remote detected');
      expect(errored()).not.toContain('gh is not authenticated');
    });

    it('status exits 2 with the no GitHub remote wording when no remote points to github.com (#2594)', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) {
          throw Object.assign(new Error('Command failed: gh repo view'), {
            stderr:
              'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n',
          });
        }
        return '';
      };
      const res = await runMain('status');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('no GitHub remote detected');
      expect(errored()).not.toContain('gh is not authenticated');
      expect(errored()).not.toContain('rejected the token');
    });

    it('status Last Events shows a config park as config (#2584)', async () => {
      mkdirSync(dirname(paths().events), { recursive: true });
      writeFileSync(
        paths().events,
        [
          { type: 'config', issue: '7', msg: 'config failure in CHECK: .factory/constitution.md:4' },
          { type: 'parked', issue: '7', msg: 'issue #7 parked (config); fix the config' },
        ]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
      );
      await runMain('status');
      const out = logged();
      expect(out).toContain('config #7: config failure in CHECK');
      expect(out).toContain('parked (config)');
    });

    describe('base hold (#2351)', () => {
      const writeHold = (repo: string): void => {
        mkdirSync(dirname(paths().baseHold), { recursive: true });
        writeFileSync(
          paths().baseHold,
          JSON.stringify({
            repo,
            baseSha: 'a'.repeat(40),
            failingChecks: ['tests', 'lint'],
            since: '2026-10-01T00:00:00.000Z',
          }),
        );
      };

      it('shows the active base hold with repo, baseSha, failing checks and since (#2351)', async () => {
        writeHold(h.ghRepo);
        await runMain('status');
        const out = logged();
        expect(out).toContain('== Base hold ==');
        expect(out).toContain(`repo: ${h.ghRepo}`);
        expect(out).toContain(`baseSha: ${'a'.repeat(40)}`);
        expect(out).toContain('failingChecks: tests, lint');
        expect(out).toContain('since: 2026-10-01T00:00:00.000Z');
        expect(out.indexOf('== Active ==')).toBeLessThan(out.indexOf('== Base hold =='));
        expect(out.indexOf('== Base hold ==')).toBeLessThan(out.indexOf('== Queue =='));
        expect(existsSync(paths().baseHold)).toBe(true);
      });

      it('omits the base hold section when no hold file exists (#2351)', async () => {
        await runMain('status');
        expect(logged()).not.toContain('Base hold');
      });

      it('prints no base hold section for a hold on another repo (#2351)', async () => {
        writeHold('someone/else');
        await runMain('status');
        expect(logged()).not.toContain('Base hold');
      });

      it('prints no base hold section for a malformed hold file (#2351)', async () => {
        mkdirSync(dirname(paths().baseHold), { recursive: true });
        writeFileSync(paths().baseHold, 'not json');
        await runMain('status');
        expect(logged()).not.toContain('Base hold');
      });

      it('`status --json` is unchanged by a base hold (#2351)', async () => {
        writeHold(h.ghRepo);
        await runMain('status', '--json');
        expect(JSON.parse(logged())).not.toHaveProperty('baseHold');
      });
    });

    describe('update state (#2129)', () => {
      let home: string;
      beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'factory-update-home-'));
        vi.stubEnv('HOME', home);
      });
      afterEach(() => {
        vi.unstubAllEnvs();
        rmSync(home, { recursive: true, force: true });
      });
      const writeState = (extra: Record<string, unknown> = {}): void => {
        mkdirSync(join(home, '.factory'), { recursive: true });
        writeFileSync(
          join(home, '.factory', 'update-state.json'),
          JSON.stringify({
            schemaVersion: 1,
            mode: 'stable',
            channel: 'latest',
            installKind: 'npm-global',
            current: '0.9.0',
            available: '0.9.1',
            ...extra,
          }),
        );
      };

      it('status --json reports the factoryd update state from update-state.json (#2129)', async () => {
        writeState();
        await runMain('status', '--json');
        expect(JSON.parse(logged()).update).toMatchObject({
          mode: 'stable',
          channel: 'latest',
          installKind: 'npm-global',
          current: '0.9.0',
          available: '0.9.1',
        });
      });

      it('status --json reports update null without a state file', async () => {
        await runMain('status', '--json');
        expect(JSON.parse(logged()).update).toBeNull();
      });

      it('status prints the last update result line (#2129)', async () => {
        writeState({ lastResult: { at: '2026-10-01T00:00:00.000Z', version: '0.9.1', outcome: 'rolled-back' } });
        await runMain('status');
        const line = logged()
          .split('\n')
          .find((l) => l.includes('factory 0.9.0'));
        expect(line).toContain('0.9.1');
        expect(line).toContain('rolled back');
      });
    });

    describe('--json', () => {
      it('reports stop:true and nothing but JSON on stdout', async () => {
        writeFileSync(paths().stop, '');
        await runMain('status', '--json');
        const out = logged();
        expect(out).not.toContain('== Active ==');
        const json = JSON.parse(out);
        expect(json.schemaVersion).toBe(1);
        expect(json.stop).toBe(true);
      });

      it('lists a fresh active claim', async () => {
        writeFileSync(paths().queue, 'app 1\n');
        await FactoryCore.writePhaseSnapshot(FactoryCore.phaseSnapshotFile(paths().runs, workKeyFromIssue(1)), {
          issue: 1,
          phase: 'build',
          updatedAt: new Date().toISOString(),
          lastActivityAt: new Date().toISOString(),
        });
        await runMain('status', '--json');
        const json = JSON.parse(logged());
        expect(json.active).toHaveLength(1);
        expect(json.active[0]).toMatchObject({ lane: 'app', issue: 1, phase: 'build' });
        expect(typeof json.active[0].ageSec).toBe('number');
      });

      it('reports an open provider breaker', async () => {
        writeFileSync(
          paths().breaker,
          JSON.stringify({
            version: 1,
            providers: {
              openai: { reason: 'usage_cap', openedAt: new Date().toISOString(), cooldownMs: 1_800_000 },
            },
          }),
        );
        await runMain('status', '--json');
        const json = JSON.parse(logged());
        expect(json.breaker.open).toBe(true);
        expect(json.breaker.providers[0].provider).toBe('openai');
      });

      it('ignores --kpis', async () => {
        await runMain('status', '--json');
        const plain = logged();
        await runMain('status', '--json', '--kpis');
        const both = logged().slice(plain.length);
        expect(both).not.toContain('Effective config');
        expect(JSON.parse(both)).toEqual(JSON.parse(plain));
      });

      it('exits 2 with an error on stderr when .factory is missing', async () => {
        rmSync(paths().root, { recursive: true, force: true });
        const result = await runMain('status', '--json');
        expect(result).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('factory not initialized');
        expect(logged()).toBe('');
      });
    });

    it('prints product, models, queue, events, and STOP state', async () => {
      writeFileSync(paths().product, 'alpha\n');
      writeFileSync(paths().queue, '# comment\napp 1\napp 2\n');
      await FactoryCore.writePhaseSnapshot(FactoryCore.phaseSnapshotFile(paths().runs, workKeyFromIssue(1)), {
        issue: 1,
        phase: 'build',
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      });
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ type: 'ready', issue: 1, msg: 'done' }),
          'not-json',
          JSON.stringify({ type: 'issue-title', issue: '2', msg: 'title' }),
          JSON.stringify({ type: 'merged', issue: '2', msg: 'merged' }),
          JSON.stringify({ type: 'issue-title', issue: '3', msg: 'title' }),
          JSON.stringify({ type: 'rework', issue: '3', msg: 'rework' }),
          JSON.stringify({ type: 'issue-title', issue: '4', msg: 'title' }),
          JSON.stringify({ type: 'parked', issue: '4', msg: 'parked' }),
          '',
        ].join('\n'),
      );
      writeFileSync(paths().stop, '');
      await runMain('status');
      expect(vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value.setCodexFullAccessTasks).toHaveBeenCalledWith(
        [],
      );
      const out = logged();
      expect(out).toContain('on-par/software-factory');
      expect(out).toContain('Product: alpha');
      expect(out).toMatch(/app #1 {2}\[build, .+ ago\]/);
      expect(out).toContain('(1 stale entry hidden — no recent activity)');
      expect(out).toContain('ready #1: done');
      expect(out).toContain('== Health ==');
      expect(out).toContain('Effective config and KPIs hidden');
      expect(out).not.toContain('Effective config:');
      expect(out).not.toContain('Merge rate:');
      expect(logged() + errored()).toContain('STOP is set');
    });

    describe('STOP line (#2544)', () => {
      it('says STOP is set, since when, and to run factory resume when the STOP file exists', async () => {
        writeFileSync(paths().stop, '');
        await runMain('status');
        const out = logged();
        expect(out).toContain('STOP is set');
        expect(out).toContain('factory resume');
        expect(out).toMatch(/since \d{4}-\d{2}-\d{2}T/);
      });

      it('prints no STOP line when the STOP file is absent', async () => {
        await runMain('status');
        const out = logged();
        expect(out).not.toContain('STOP is set');
        expect(out).not.toContain('STOP file present');
      });
    });

    it('shows full Effective config and KPIs when --kpis is passed', async () => {
      await runMain('status', '--kpis');
      const out = logged();
      expect(out).toContain('Effective config:');
      expect(out).toContain('Plan model:');
      expect(out).toContain('No factory runs recorded yet.');
    });

    it('auto-merge flag: status --kpis attributes the auto-merge policy to the flag', async () => {
      mkdirSync(paths().state, { recursive: true });
      writeFileSync(paths().runFlags, JSON.stringify({ autoMerge: true }));
      await runMain('status', '--kpis');
      expect(logged()).toContain('Merge auto: on (flag: --auto-merge)');

      writeFileSync(paths().runFlags, JSON.stringify({ autoMerge: false }));
      await runMain('status', '--kpis');
      expect(logged()).toContain('Merge auto: off (flag: --no-auto-merge)');
    });

    it('renders Active, Queue, and Health as three distinct labeled bands, in that order (#1344)', async () => {
      await runMain('status');
      const out = logged();
      const activeIdx = out.indexOf('== Active ==');
      const queueIdx = out.indexOf('== Queue ==');
      const healthIdx = out.indexOf('== Health ==');
      expect(activeIdx).toBeGreaterThan(-1);
      expect(queueIdx).toBeGreaterThan(activeIdx);
      expect(healthIdx).toBeGreaterThan(queueIdx);
    });

    it('handles an empty queue and no events gracefully', async () => {
      writeFileSync(paths().queue, '# only comments\n');
      await runMain('status');
      const out = logged();
      expect(out).toContain('(idle — no active claims)');
      expect(out).toContain('(none)');
      expect(out).toContain('Product: (none)');
    });

    it('warns on malformed queue lines and never renders NaN', async () => {
      writeFileSync(paths().queue, 'app 1\napp abc\n');
      await FactoryCore.writePhaseSnapshot(FactoryCore.phaseSnapshotFile(paths().runs, workKeyFromIssue(1)), {
        issue: 1,
        phase: 'build',
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      });
      await runMain('status');
      expect(logged()).toMatch(/app #1 {2}\[build, 2m ago\]/);
      const err = errored();
      expect(err).toContain('malformed');
      expect(err).toContain('line 2');
      expect(logged() + err).not.toContain('NaN');
    });

    it('excludes stale local queue entries from the active view without touching the queue file (#1342)', async () => {
      const staleLines = Array.from({ length: 60 }, (_, i) => `app ${i + 1}`).join('\n') + '\n';
      writeFileSync(paths().queue, staleLines);
      const before = readFileSync(paths().queue, 'utf-8');

      await runMain('status');
      const out = logged();

      expect(out).not.toMatch(/ {2}app #?\d+/m);
      expect(out).toContain('(idle — no active claims)');
      expect(out).toContain('(60 stale entries hidden — no recent activity)');
      expect(readFileSync(paths().queue, 'utf-8')).toBe(before);
    });

    it('prints the idle line, not "(no queue file)", on a GitHub-queue repo with no queue file (#3344)', async () => {
      const res = await runMain('status');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('(idle — no active claims)');
      expect(logged()).not.toContain('(no queue file)');
    });

    it('lists only claimable GitHub-backed work in the Queue band (#1344)', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels }: any) => {
        if (labels === 'factory:queued') {
          return { data: [{ number: 42, labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'] }] };
        }
        if (labels === 'factory:queued,factory:lane:daw') {
          return { data: [{ number: 42, labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'] }] };
        }
        return { data: [] };
      });

      await runMain('status');
      const out = logged();
      const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
      expect(queueBand).toContain('daw #42');
    });

    it('lists all issues queued into one lane in order, with no local queue file (#977)', async () => {
      const issues = [
        { number: 1236, labels: ['factory:queued', 'factory:lane:launch-trust', 'factory:order:1'] },
        { number: 1234, labels: ['factory:queued', 'factory:lane:launch-trust', 'factory:order:2'] },
        { number: 1235, labels: ['factory:queued', 'factory:lane:launch-trust', 'factory:order:3'] },
      ];
      h.octokit.rest.issues.listForRepo = vi.fn(async ({ labels }: any) => {
        if (labels === 'factory:queued') return { data: issues };
        if (labels === 'factory:queued,factory:lane:launch-trust') return { data: issues };
        return { data: [] };
      });

      const res = await runMain('status');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('(idle — no active claims)');
      const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
      expect(queueBand).not.toContain('(empty)');
      expect(queueBand).not.toContain('(no claimable work)');
      expect(queueBand).toContain('launch-trust #1236');
      expect(queueBand).toContain('launch-trust #1234');
      expect(queueBand).toContain('launch-trust #1235');
      expect(queueBand.indexOf('#1236')).toBeLessThan(queueBand.indexOf('#1234'));
      expect(queueBand.indexOf('#1234')).toBeLessThan(queueBand.indexOf('#1235'));
    });

    it('reports a queue lookup failure in the Queue band without crashing status (#1344)', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('GitHub API unavailable');
      });

      const res = await runMain('status');
      expect(res.exited).toBe(false);
      const out = logged();
      const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
      expect(queueBand).toContain('queue lookup failed — GitHub API unavailable');
    });

    it('shows "(no claimable work)" in the Queue band when nothing is claimable', async () => {
      await runMain('status');
      const out = logged();
      const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
      expect(queueBand).toContain('(no claimable work)');
    });

    it('shows a no-token message in the Queue band instead of calling GitHub when unauthenticated', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = () => {
        throw new Error('gh not authenticated');
      };
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      await runMain('status');
      const out = logged();
      const queueBand = out.slice(out.indexOf('== Queue =='), out.indexOf('== Health =='));
      expect(queueBand).toContain('no GitHub token');
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it('shows an open provider breaker under Health without mutating the breaker file', async () => {
      const breakerFixture = {
        version: 1,
        providers: {
          openai: { reason: 'usage_cap', openedAt: new Date().toISOString(), cooldownMs: 1_800_000 },
        },
      };
      writeFileSync(paths().breaker, JSON.stringify(breakerFixture));

      await runMain('status');
      const out = logged();
      expect(out).toContain('== Health ==');
      expect(out).toContain('Provider breaker:');
      expect(out).toContain('openai: OPEN (usage_cap)');
      expect(out).toContain('m remaining');
      expect(existsSync(paths().breaker)).toBe(true);
    });

    it('shows "(closed)" when there is no breaker file', async () => {
      await runMain('status');
      const out = logged();
      expect(out).toContain('Provider breaker:');
      expect(out).toContain('(closed)');
    });
  });
});
