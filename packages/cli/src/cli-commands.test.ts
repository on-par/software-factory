import type * as ChildProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import * as FactoryCore from '@on-par/factory-core';
import { eventSegmentFileName, eventSegmentsDir } from '@on-par/factory-core/internal';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { FACTORYD_LABEL, factorydFiles } from './cli/daemon.js';
import { HELP_GROUPS, OTHER_GROUP } from './cli/help-groups.js';
import { CliExitError, cmdConstitution, LaneParkError, ghRepoViewFailureMessage } from './cli/index.js';
import {
  cmdUsage,
  coreFakes,
  errored,
  exitSpy,
  h,
  installCliCommandsHarness,
  logged,
  logSpy,
  ops,
  paths,
  phases,
  runMain,
  runMainWith,
  setupWorktree,
  shipIssue,
  trackEnv,
} from './cli/test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('triage', () => {
    it('triage exits 2 with gh auth login guidance when gh is not authenticated (#2592)', async () => {
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
      const res = await runMain('triage');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('gh is not authenticated');
      expect(errored()).toContain('gh auth login');
      expect(errored()).not.toContain('no GitHub remote detected');
    });

    const ghIssues = JSON.stringify([
      { number: 5, title: 'Five', labels: [{ name: 'bug' }], body: 'x'.repeat(10_000) },
      { number: 6, title: 'Six', labels: [], body: 'short' },
    ]);
    const execWithIssues = (cmd: string) => {
      if (cmd.includes('rev-parse')) return h.repoRoot;
      if (cmd.includes('gh repo view')) return h.ghRepo;
      if (cmd.includes('gh issue list')) return ghIssues;
      return '';
    };

    it('dispatches through the router, never spawns claude -p, and writes a valid proposal (#1650)', async () => {
      const cmds: string[] = [];
      h.execImpl = (cmd: string) => {
        cmds.push(cmd);
        return execWithIssues(cmd);
      };
      let seenPrompt = '';
      h.routerRun = async (task, prompt) => {
        expect(task).toBe('triage');
        seenPrompt = prompt;
        return { model: 'gpt-5.6-luna-high', output: '```\n# header\n\napp 5\napp #6\n```\n' };
      };
      await runMain('triage');
      expect(cmds.some((c) => c.includes('claude -p'))).toBe(false);
      expect(seenPrompt).toContain('#5: Five [labels: bug]');
      expect(seenPrompt).not.toContain('x'.repeat(1_500));
      const proposed = readFileSync(paths().queueProposed, 'utf-8');
      expect(proposed).toBe('# Triage queue (model gpt-5.6-luna-high)\n# header\napp 5\napp 6\n');
      expect(logged()).toContain('factory triage accept');
      expect(readFileSync(paths().events, 'utf-8')).toContain('with gpt-5.6-luna-high');
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('2 issue(s) promoted');
    });

    it('passes --model to the router as the model override', async () => {
      h.execImpl = execWithIssues;
      let seenOpts: any;
      h.routerRun = async (_task, _prompt, opts) => {
        seenOpts = opts;
        return { model: 'gpt-5.6-terra-high', output: 'app 5\n' };
      };
      await runMain('triage', '--model', 'gpt-5.6-terra-high');
      expect(seenOpts.modelOverride).toBe('gpt-5.6-terra-high');
    });

    it('exits 1 when triage produces no proposal', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => ({ model: 'm', output: 'I could not decide.' });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('logs the planner failure detail and exits 1 with no proposal when the router fails', async () => {
      h.execImpl = execWithIssues;
      h.routerRun = async () => {
        throw new Error('codex crashed');
      };
      const res = await runMain('triage');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no proposal');
      expect(errored()).toContain('codex crashed');
      expect(readFileSync(paths().events, 'utf-8')).toContain('triage planner failed');
    });
  });

  describe('triage accept', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('accepts a valid proposed queue', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp 6\n');
      await runMain('triage', 'accept');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 5\napp 6\n');
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('5, 6');
    });

    it('accepts a proposal with a header, comments and a blank line before the first entry', async () => {
      const body = '# Triage queue — constitution: default-code\n# c1\n# c2\n# c3\n# c4\n\ngreet 1\n';
      writeFileSync(paths().queueProposed, body);
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe(body);
      expect(logged()).toContain('queue accepted');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('"type":"triage_accepted"');
      expect(events).toContain('1');
    });

    it('rejects an invalid queue and leaves it unchanged', async () => {
      writeFileSync(paths().queueProposed, 'app 5\napp notanumber\n');
      const res = await runMain('triage', 'accept');
      expect(res).toEqual({ exited: true, code: 1 });
      const err = errored();
      expect(err).toContain('invalid');
      expect(err).toContain('malformed');
      expect(existsSync(paths().queueProposed)).toBe(true);
      expect(readFileSync(paths().queueProposed, 'utf-8')).toBe('app 5\napp notanumber\n');
      expect(existsSync(paths().queue)).toBe(false);
    });

    it('reports nothing to accept when there is no proposed queue', async () => {
      const res = await runMain('triage', 'accept');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('nothing to accept');
    });

    it('--force skips validation and promotes as-is', async () => {
      writeFileSync(paths().queueProposed, 'app notanumber\n');
      await runMain('triage', 'accept', '--force');
      expect(existsSync(paths().queueProposed)).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app notanumber\n');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('triage_accepted');
      expect(events).toContain('--force');
    });
  });

  describe('queue migrate', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
    });

    it('migrates valid local queue entries in per-lane order without rewriting the source queue', async () => {
      const source = 'daw 1055\ndocs 200\ndaw 993\n';
      writeFileSync(paths().queue, source);

      const res = await runMain('queue', 'migrate');

      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe(source);
      expect(logged()).toContain('queue migrated — 3 issue(s)');
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(1, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 1055,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
      });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(2, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 200,
        labels: ['factory:queued', 'factory:lane:docs', 'factory:order:1'],
      });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(3, {
        owner: 'on-par',
        repo: 'software-factory',
        issue_number: 993,
        labels: ['factory:queued', 'factory:lane:daw', 'factory:order:2'],
      });
      expect(h.octokit.rest.issues.createLabel).toHaveBeenCalled();
    });

    it('rejects a missing local queue before creating or applying labels', async () => {
      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('queue not found');
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects an invalid local queue before creating or applying labels', async () => {
      writeFileSync(paths().queue, 'daw 1055\ndaw invalid\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('queue is invalid');
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects a queue with a duplicate issue number before any GitHub call', async () => {
      writeFileSync(paths().queue, 'daw 1055\ndocs 1055\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('duplicate issue #1055');
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('rejects an empty queue with no issue entries', async () => {
      writeFileSync(paths().queue, '\n# nothing queued yet\n');

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no issue entries');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('aborts the whole migration when an entry is a pull request, not an issue', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'x', pull_request: {} } }));

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('is a pull request');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('previews the migration plan without mutating GitHub in --dry-run', async () => {
      const source = 'daw 1055\ndocs 200\n';
      writeFileSync(paths().queue, source);

      const res = await runMain('queue', 'migrate', '--dry-run');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('dry run');
      expect(logged()).toContain('#1055 → lane daw, position 1');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(readFileSync(paths().queue, 'utf-8')).toBe(source);
    });

    it('aborts the whole migration when an entry is a closed issue', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'x', state: 'closed' } }));

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('closed');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('aborts the whole migration when an entry is inaccessible', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      });

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('inaccessible');
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('surfaces a GitHub failure during apply as a CliExitError', async () => {
      writeFileSync(paths().queue, 'daw 1055\n');
      h.octokit.rest.issues.addLabels = vi.fn(async () => {
        throw new Error('label API down');
      });

      const res = await runMain('queue', 'migrate');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('queue migration failed');
    });

    it('migrates from an explicit --file path, leaving the default queue untouched', async () => {
      const legacyFile = join(paths().root, 'legacy-queue');
      writeFileSync(legacyFile, 'daw 1055\n');

      const res = await runMain('queue', 'migrate', '--file', '.factory/legacy-queue');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('labelled from');
      expect(logged()).toContain(legacyFile);
      expect(existsSync(paths().queue)).toBe(false);
    });
  });

  describe('queue add', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [] }));
    });

    it.each(['', '   '])('exits 2 for an empty or whitespace lane before any GitHub call', async (lane) => {
      const res = await runMain('queue', 'add', lane, '1');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('lane');
      for (const fn of ['createLabel', 'addLabels', 'listForRepo'] as const)
        expect(h.octokit.rest.issues[fn]).not.toHaveBeenCalled();
    });

    it('prints the applied lane slug in the success line', async () => {
      await runMain('queue', 'add', 'a b', '1');
      expect(logged()).toContain('lane a-b');
      expect(logged()).not.toContain('lane a b');
    });

    it('queues explicit issues into a lane, applying queued/lane/order labels in order', async () => {
      const res = await runMain('queue', 'add', 'daw', '10', '11');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#10 queued');
      expect(logged()).toContain('#11 queued');
      for (const [i, issue_number] of [10, 11].entries()) {
        expect(h.octokit.rest.issues.addLabels).toHaveBeenNthCalledWith(i + 1, {
          owner: 'on-par',
          repo: 'software-factory',
          issue_number,
          labels: ['factory:queued', 'factory:lane:daw', `factory:order:${i + 1}`],
        });
      }
    });

    it('creates missing factory labels idempotently before applying them', async () => {
      await runMain('queue', 'add', 'daw', '10');
      for (const name of ['factory:queued', 'factory:lane:daw', 'factory:order:1'])
        expect(h.octokit.rest.issues.createLabel).toHaveBeenCalledWith(expect.objectContaining({ name }));
    });

    it('exits nonzero and reports a per-issue failure without dropping the successful issue', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('#10 failed');
      expect(logged()).toContain('#11 queued');
    });

    it('exits 2 for an invalid issue argument before any GitHub call', async () => {
      const res = await runMain('queue', 'add', 'daw', 'notanumber');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });

    it('--json prints exactly one JSON object with orders and created labels', async () => {
      const res = await runMain('queue', 'add', 'ops', '1', '2', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json.ok).toBe(true);
      expect(json.issues.map((i: any) => [i.number, i.order])).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(json.labelsCreated).toEqual(
        expect.arrayContaining(['factory:queued', 'factory:lane:ops', 'factory:order:1']),
      );
    });

    it('--json reports an already-queued issue with its order and no writes', async () => {
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: any) => ({
        data: issue_number === 1 ? [{ name: 'factory:order:5' }] : [],
      }));

      await runMain('queue', 'add', 'ops', '1', '2', '--json');

      const json = JSON.parse(logged());
      expect(json.issues[0]).toEqual({ number: 1, outcome: 'already-queued', order: 5, labelsAdded: [] });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 2 }));
    });

    it('--json reports no created labels when they already exist (422)', async () => {
      h.octokit.rest.issues.createLabel = vi.fn(async () => {
        throw { status: 422 };
      });

      await runMain('queue', 'add', 'ops', '1', '--json');

      expect(JSON.parse(logged()).labelsCreated).toEqual([]);
    });

    it('--json prints ok:false and exits 1 on a partial failure', async () => {
      h.octokit.rest.issues.addLabels = vi.fn(async ({ issue_number }: any) => {
        if (issue_number === 10) throw new Error('label API down');
        return {};
      });

      const res = await runMain('queue', 'add', 'daw', '10', '11', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged().trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged()).ok).toBe(false);
      expect(errored()).toContain('failed to queue');
    });

    it('--json exits 1 with empty stdout when the lane listing throws', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('api down');
      });

      const res = await runMain('queue', 'add', 'ops', '1', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue add failed');
    });

    it('text mode prints only the per-issue lines (no event echo)', async () => {
      await runMain('queue', 'add', 'daw', '10', '11');

      expect(logged().split('\n').filter(Boolean)).toHaveLength(2);
      expect(logged()).not.toContain('queue_added');
    });

    it('records a queue_added event only when something was queued', async () => {
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"queue_added"');

      rmSync(paths().events, { force: true });
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: [{ name: 'factory:order:1' }] }));
      await runMain('queue', 'add', 'ops', '1', '--json');
      expect(existsSync(paths().events)).toBe(false);
    });
  });

  describe('unpark', () => {
    let labels: string[];
    beforeEach(() => {
      labels = ['factory:parked', 'factory:lane:ops'];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.addLabels = vi.fn(async ({ labels: add }: any) => {
        labels.push(...add.filter((l: string) => !labels.includes(l)));
        return {};
      });
      h.octokit.rest.issues.removeLabel = vi.fn(async ({ name }: any) => {
        labels = labels.filter((l) => l !== name);
        return {};
      });
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [{ number: 12, labels: [labels[1]] }] }));
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async () => ({ data: labels.map((name) => ({ name })) }));
    });

    it('--json re-queues a parked issue and prints one object', async () => {
      const res = await runMain('unpark', '12', '--json');

      expect(res.exited).toBe(false);
      expect(logged().trim().split('\n')).toHaveLength(1);
      const json = JSON.parse(logged());
      expect(json).toMatchObject({ schemaVersion: 1, action: 'unpark', issue: 12, lane: 'ops', order: 1 });
      expect(h.octokit.rest.issues.addLabels).toHaveBeenCalledWith(
        expect.objectContaining({ labels: expect.arrayContaining(['factory:order:1']) }),
      );
      expect(h.octokit.rest.issues.removeLabel).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'factory:parked' }),
      );
    });

    it('text mode prints the position line', async () => {
      await runMain('unpark', '12');
      expect(logged()).toContain('#12 unparked → lane ops, position 1');
    });

    it('fails with [not-parked], empty stdout and no event when not parked', async () => {
      labels = ['factory:lane:ops'];
      const res = await runMain('unpark', '12', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('[not-parked]');
      expect(existsSync(paths().events)).toBe(false);
    });

    it('fails with [lane-required] when no lane label and no --lane', async () => {
      labels = ['factory:parked'];
      const res = await runMain('unpark', '12');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('[lane-required]');
    });

    it('records an issue_unparked event on success', async () => {
      await runMain('unpark', '12', '--json');
      expect(readFileSync(paths().events, 'utf-8')).toContain('"type":"issue_unparked"');
    });

    it('exits 2 for an invalid issue argument', async () => {
      const res = await runMain('unpark', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
    });
  });

  describe('queue reconcile', () => {
    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          {
            number: 10,
            title: 'Queued issue',
            labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'],
          },
        ],
      }));
    });

    it('exits 0 and reports no conflicts when no admission.json is present', async () => {
      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('1 queued issue(s), 0 conflict(s)');
      expect(logged()).toContain('no Factory App admission conflicts');
    });

    it('exits 1 and reports the conflict when admission state refuses the issue', async () => {
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [{ issue: 10, state: 'executing', deliveryId: 'del-1' }],
        }),
      );

      const res = await runMain('queue', 'reconcile');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[daw] #10:');
      expect(logged()).toContain('repair:');
    });

    it('--lane filters the report to a single lane', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, labels: ['factory:queued', 'factory:lane:daw', 'factory:order:1'] },
          { number: 20, labels: ['factory:queued', 'factory:lane:other', 'factory:order:1'] },
        ],
      }));
      writeFileSync(
        join(paths().state, 'admission.json'),
        JSON.stringify({
          version: 1,
          records: [
            { issue: 10, state: 'executing' },
            { issue: 20, state: 'executing' },
          ],
        }),
      );

      const res = await runMain('queue', 'reconcile', '--lane', 'other');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toContain('1 queued issue(s), 1 conflict(s)');
      expect(logged()).toContain('[other] #20:');
      expect(logged()).not.toContain('[daw]');
    });
  });

  describe('queue list', () => {
    const issue = (number: number, labels: string[], title?: string) => ({
      number,
      ...(title === undefined ? {} : { title }),
      labels,
    });

    beforeEach(() => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));
      h.octokit.rest.issues.removeLabel = vi.fn(async () => ({}));
      h.octokit.rest.issues.createLabel = vi.fn(async () => ({}));
    });

    const twoLanes = (): void => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(2, ['factory:queued', 'factory:lane:other', 'factory:order:5'], 'Two'),
          issue(3, ['factory:queued', 'factory:lane:daw', 'factory:order:9'], 'Three'),
          issue(1, ['factory:queued', 'factory:lane:daw', 'factory:order:2'], 'One'),
        ],
      }));
    };

    it('lists lanes sorted with items in order-label order, read-only', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        lanes: [
          {
            lane: 'daw',
            items: [
              { issue: 1, title: 'One', status: 'queued', order: 1, claimedBy: null },
              { issue: 3, title: 'Three', status: 'queued', order: 2, claimedBy: null },
            ],
          },
          { lane: 'other', items: [{ issue: 2, title: 'Two', status: 'queued', order: 1, claimedBy: null }] },
        ],
        orderConflicts: [],
      });
      expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.removeLabel).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.createLabel).not.toHaveBeenCalled();
    });

    it('--lane returns only that lane', async () => {
      twoLanes();

      const res = await runMain('queue', 'list', '--json', '--lane', 'other');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged()).lanes.map((l: { lane: string }) => l.lane)).toEqual(['other']);
    });

    it('reports parked status', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [issue(4, ['factory:queued', 'factory:lane:daw', 'factory:order:1', 'factory:parked'])],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({ issue: 4, status: 'parked' });
    });

    it('reports in-progress status and claimant', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          issue(5, [
            'factory:queued',
            'factory:lane:daw',
            'factory:order:1',
            'factory:in-progress',
            'factory:claimed-by:host-1',
          ]),
        ],
      }));

      await runMain('queue', 'list', '--json');

      expect(JSON.parse(logged()).lanes[0].items[0]).toMatchObject({
        issue: 5,
        status: 'in-progress',
        claimedBy: 'host-1',
      });
    });

    it('prints empty lanes when nothing is queued', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(JSON.parse(logged())).toEqual({ schemaVersion: 1, lanes: [], orderConflicts: [] });
    });

    it('exits 1 with stderr only on a GitHub read failure', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw Object.assign(new Error('Bad credentials'), { status: 401 });
      });

      const res = await runMain('queue', 'list', '--json');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(logged()).toBe('');
      expect(errored()).toContain('queue list failed');
      expect(errored()).toContain('Bad credentials');
    });

    it('exits 2 without --json and makes no GitHub call', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'list');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
      expect(h.octokit.rest.issues.listForRepo).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    const runsDir = (): string => FactoryCore.getFactoryPaths(h.repoRoot).runs;
    const writeRun = (n: number, updatedAt: string): void => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(
        join(runsDir(), `issue-${n}.json`),
        JSON.stringify({ issue: n, lane: 'daw', startedAt: updatedAt, updatedAt }),
      );
    };

    beforeEach(() => {
      h.execImpl = (cmd: string) => (cmd.includes('rev-parse') ? h.repoRoot : '');
    });

    it('prints runs newest first', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');
      writeRun(3, '2026-01-02T00:00:00Z');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { schemaVersion: number; runs: Array<{ issue: number }> };
      expect(out.schemaVersion).toBe(1);
      expect(out.runs.map((r) => r.issue)).toEqual([2, 3, 1]);
    });

    it('honors --limit', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeRun(2, '2026-01-03T00:00:00Z');

      await runMain('runs', '--json', '--limit', '1');

      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('prints an empty list when there is no runs dir', async () => {
      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toBe('{"schemaVersion":1,"runs":[]}');
    });

    it('skips a malformed file with a stderr note and exit 0', async () => {
      writeRun(1, '2026-01-01T00:00:00Z');
      writeFileSync(join(runsDir(), 'issue-9.json'), '{not json');

      const res = await runMain('runs', '--json');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(errored()).toContain('skipped malformed issue-9.json');
      expect((JSON.parse(logged()) as { runs: unknown[] }).runs).toHaveLength(1);
    });

    it('exits 2 without --json', async () => {
      const res = await runMain('runs');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
      expect(logged()).toBe('');
    });

    it('exits 2 on an invalid --limit', async () => {
      const res = await runMain('runs', '--json', '--limit', '0');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --limit');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 1 when the issue has no run', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '99');

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('no run for issue #99');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 on an invalid issue', async () => {
      const res = await runMain('runs', '--json', '--diffstat', 'abc');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid --diffstat');
      expect(logged()).toBe('');
    });

    it('--diffstat exits 2 without --json', async () => {
      const res = await runMain('runs', '--diffstat', '5');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('requires --json');
    });

    it('--diffstat exits 2 when combined with --limit', async () => {
      const res = await runMain('runs', '--json', '--diffstat', '5', '--limit', '2');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('cannot be combined');
    });

    it('--diffstat prints files null with reason no-branch for an empty branch', async () => {
      mkdirSync(runsDir(), { recursive: true });
      writeFileSync(
        join(runsDir(), 'issue-5.json'),
        JSON.stringify({ issue: 5, lane: 'daw', branch: '', updatedAt: '2026-01-01T00:00:00Z' }),
      );

      const res = await runMain('runs', '--json', '--diffstat', '5');

      expect(res).toEqual({ exited: false, code: undefined });
      const out = JSON.parse(logged()) as { files: unknown; reason: string; base: unknown };
      expect(out.files).toBeNull();
      expect(out.reason).toBe('no-branch');
      expect(typeof out.base).toBe('string');
    });
  });

  describe('queue clear', () => {
    const removeLabel = vi.fn();
    const addLabels = vi.fn();

    beforeEach(() => {
      removeLabel.mockClear();
      addLabels.mockClear();
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      h.octokit.rest.issues.removeLabel = removeLabel;
      h.octokit.rest.issues.addLabels = addLabels;
      const labelsFor = (n: number): string[] =>
        n === 10
          ? ['factory:queued', 'factory:lane:daw', 'factory:order:1']
          : n === 11
            ? ['factory:queued', 'factory:lane:daw', 'factory:in-progress', 'factory:claimed-by:host-1']
            : ['factory:queued', 'factory:lane:daw'];
      h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
        data: labelsFor(issue_number).map((name) => ({ name })),
      }));
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({
        data: [
          { number: 10, title: 'Queued issue', labels: labelsFor(10) },
          { number: 11, labels: labelsFor(11) },
          { number: 12, labels: labelsFor(12) },
        ],
      }));
    });

    it('--dry-run lists every queued issue with its lane and exits 0 without writing', async () => {
      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      for (const n of [10, 11, 12]) expect(logged()).toContain(`#${n} [lane daw]`);
      expect(logged()).toContain('would-skip');
      expect(logged()).toContain('3 queued issue(s): 2 would-clear, 1 would-skip');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('exits 2 without --dry-run or --yes, after printing the preview', async () => {
      const res = await runMain('queue', 'clear');

      expect(res).toEqual({ exited: true, code: 2 });
      expect(logged()).toContain('#10 [lane daw] would-clear');
      expect(errored()).toContain('--yes');
      expect(removeLabel).not.toHaveBeenCalled();
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes removes queue labels, keeps lanes, and skips claimed issues', async () => {
      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('#10 [lane daw] cleared');
      expect(logged()).toContain('#11 [lane daw] skipped — claimed');
      expect(logged()).toContain('#12 [lane daw] cleared');
      expect(logged()).toContain('3 queued issue(s): 2 cleared, 1 skipped');
      const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
      expect(removed).toContainEqual([10, 'factory:queued']);
      expect(removed).toContainEqual([10, 'factory:order:1']);
      expect(removed).toContainEqual([12, 'factory:queued']);
      expect(removed.some(([n]) => n === 11)).toBe(false);
      expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      expect(addLabels).not.toHaveBeenCalled();
    });

    it('--yes on an empty queue reports it and does not remove labels', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--yes');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
      expect(removeLabel).not.toHaveBeenCalled();
    });

    it('reports an already-empty queue and exits 0', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));

      const res = await runMain('queue', 'clear', '--dry-run');

      expect(res).toEqual({ exited: false, code: undefined });
      expect(logged()).toContain('already empty');
    });

    describe('--lane', () => {
      const issueLabels: Record<number, string[]> = {
        10: ['factory:queued', 'factory:lane:ops', 'factory:order:1'],
        11: ['factory:queued', 'factory:lane:review', 'factory:order:2'],
        12: ['factory:queued', 'factory:lane:ops'],
      };
      let listForRepo: ReturnType<typeof vi.fn>;

      beforeEach(() => {
        h.octokit.rest.issues.listLabelsOnIssue = vi.fn(async ({ issue_number }: { issue_number: number }) => ({
          data: (issueLabels[issue_number] ?? []).map((name) => ({ name })),
        }));
        listForRepo = vi.fn(async ({ labels }: { labels: string }) => {
          const wanted = labels.split(',');
          return {
            data: Object.entries(issueLabels)
              .filter(([, ls]) => wanted.every((w) => ls.includes(w)))
              .map(([n, ls]) => ({ number: Number(n), labels: ls })),
          };
        });
        h.octokit.rest.issues.listForRepo = listForRepo;
      });

      it('--dry-run lists only that lane and writes nothing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--dry-run');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(listForRepo).toHaveBeenCalledWith(
          expect.objectContaining({ labels: 'factory:queued,factory:lane:ops' }),
        );
        expect(logged()).toContain('#10 [lane ops]');
        expect(logged()).toContain('#12 [lane ops]');
        expect(logged()).not.toContain('#11');
        expect(removeLabel).not.toHaveBeenCalled();
        expect(addLabels).not.toHaveBeenCalled();
      });

      it('--yes clears only that lane and never touches other lanes or lane labels', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'ops', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        const removed = removeLabel.mock.calls.map(([arg]) => [arg.issue_number, arg.name]);
        expect(removed).toContainEqual([10, 'factory:queued']);
        expect(removed).toContainEqual([12, 'factory:queued']);
        expect(removed.some(([n]) => n === 11)).toBe(false);
        expect(removed.some(([, name]) => String(name).startsWith('factory:lane:'))).toBe(false);
      });

      it('reports an empty lane and exits 0 without writing', async () => {
        const res = await runMain('queue', 'clear', '--lane', 'docs', '--yes');

        expect(res).toEqual({ exited: false, code: undefined });
        expect(logged()).toContain('already empty for lane docs');
        expect(removeLabel).not.toHaveBeenCalled();
      });
    });
  });

  describe('resume --from check (#2564)', () => {
    const recordPath = () => join(paths().plans, 'issue-5.check-resume.json');
    const configEnvFail = () => {
      h.checkResult = {
        passed: false,
        summary: { results: [], failures: 1 },
        reworkRounds: 0,
        environment: { baseSha: 'b'.repeat(40), failingChecks: ['unknown-checker'], cause: 'config', logPaths: [] },
      };
    };
    const writeRecord = (worktree: string) => {
      mkdirSync(paths().plans, { recursive: true });
      writeFileSync(
        recordPath(),
        JSON.stringify({
          issue: 5,
          branch: 'kept-branch',
          worktree,
          diffBase: 'dbase',
          route: 'claude',
          model: 'kept-model',
          buildMinutes: 40,
          fixTarget: '.factory/constitution.md:3',
          preservedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    };

    it('a config-caused CHECK failure parks and records no resume point (#2583)', async () => {
      configEnvFail();
      const err = await shipIssue(5, {}, { repoRoot: h.repoRoot, ghRepo: h.ghRepo }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LaneParkError);
      expect((err as LaneParkError).reason).toBe('config');
      expect(existsSync(recordPath())).toBe(false);
      expect(readFileSync(paths().events, 'utf-8')).toContain('factory unpark 5');
    });

    it('resume <issue> --from check runs CHECK in the kept worktree without setupWorktree, planPhase or buildPhase', async () => {
      const kept = join(h.repoRoot, 'kept-worktree');
      mkdirSync(kept, { recursive: true });
      writeRecord(kept);
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res.exited).toBe(false);
      expect(setupWorktree).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase.mock.calls[0][0]).toMatchObject({
        worktree: kept,
        diffBase: 'dbase',
        reworkModel: 'kept-model',
      });
      expect(existsSync(recordPath())).toBe(false);
    });

    it.each([
      ['no --from', ['resume', '5']],
      ['an unsupported phase', ['resume', '5', '--from', 'build']],
      ['--from without an issue', ['resume', '--from', 'check']],
      ['an invalid issue', ['resume', 'abc', '--from', 'check']],
      ['no preserved build', ['resume', '5', '--from', 'check']],
    ])('exits 2 and leaves STOP untouched for %s', async (_name, args) => {
      writeFileSync(paths().stop, '');
      const res = await runMain(...args);
      expect(res).toEqual({ exited: true, code: 2 });
      expect(existsSync(paths().stop)).toBe(true);
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });

    it('exits 2 when the recorded worktree no longer exists', async () => {
      writeRecord(join(h.repoRoot, 'gone'));
      const res = await runMain('resume', '5', '--from', 'check');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(phases.checkPhase).not.toHaveBeenCalled();
    });
  });

  describe('stop / resume', () => {
    it('stop writes the STOP file', async () => {
      await runMain('stop');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged()).toContain('STOP set');
    });

    it('stop routes git rev-parse through the injected exec seam', async () => {
      const commands: string[] = [];
      const recordingExec = async (cmd: string) => {
        commands.push(cmd);
        return { stdout: `${h.repoRoot}\n`, stderr: '' };
      };
      await runMainWith({ exec: recordingExec }, 'stop');
      expect(commands).toContain('git rev-parse --show-toplevel');
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume removes an existing STOP file', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume');
      expect(existsSync(paths().stop)).toBe(false);
      expect(logged()).toContain('STOP cleared');
    });

    it('resume is a no-op when there is no STOP file', async () => {
      await runMain('resume');
      expect(logged()).toContain('STOP cleared');
    });

    it('stop says a running ship finishes its current issue and the next one will not start (#2544)', async () => {
      await runMain('stop');
      expect(logged()).toMatch(/factory ship.*finishes its current issue.*won't start.*factory resume/);
    });

    it('resume text output is byte-identical without --json', async () => {
      await runMain('resume');
      expect(logged()).toBe('STOP cleared');
    });

    it('stop --json prints one JSON object when not stopped', async () => {
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(logged().split('\n')).toHaveLength(1);
      expect(JSON.parse(logged())).toEqual({
        schemaVersion: 1,
        ok: true,
        action: 'stop',
        repo: h.ghRepo,
        stopFlag: { before: false, after: true },
      });
    });

    it('stop --json is idempotent when already stopped', async () => {
      writeFileSync(paths().stop, '');
      await runMain('stop', '--json');
      expect(existsSync(paths().stop)).toBe(true);
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: true, after: true } });
    });

    it('resume --json reports before/after with and without STOP', async () => {
      writeFileSync(paths().stop, '');
      await runMain('resume', '--json');
      expect(existsSync(paths().stop)).toBe(false);
      expect(JSON.parse(logged())).toMatchObject({ action: 'resume', stopFlag: { before: true, after: false } });
    });

    it('stop leaves an existing STOP file untouched (exclusive create, no rewrite)', async () => {
      writeFileSync(paths().stop, 'set by lane');
      await runMain('stop', '--json');
      expect(readFileSync(paths().stop, 'utf-8')).toBe('set by lane');
      expect(JSON.parse(logged())).toMatchObject({ stopFlag: { before: true, after: true } });
    });

    it('resume surfaces unlink errors other than a missing STOP file', async () => {
      mkdirSync(join(paths().stop, 'nested'), { recursive: true });
      await expect(runMain('resume', '--json')).rejects.toMatchObject({ code: expect.stringMatching(/^E/) });
      expect(existsSync(paths().stop)).toBe(true);
    });

    it('resume --json is ok when STOP was not set', async () => {
      await runMain('resume', '--json');
      expect(JSON.parse(logged())).toMatchObject({ ok: true, stopFlag: { before: false, after: false } });
    });

    it('stop --json has the same shape as the golden fixture', async () => {
      await runMain('stop', '--json');
      const golden = JSON.parse(
        readFileSync(new URL('./__fixtures__/stop-resume-json/stop.json', import.meta.url), 'utf-8'),
      ) as { stopFlag: object };
      const out = JSON.parse(logged()) as { stopFlag: object };
      expect(Object.keys(out)).toEqual(Object.keys(golden));
      expect(Object.keys(out.stopFlag)).toEqual(Object.keys(golden.stopFlag));
    });

    it('records stop-file-set / stop-file-cleared events without echoing them', async () => {
      const types = () =>
        readFileSync(paths().events, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { type: string }).type);
      await runMain('stop');
      expect(types()).toEqual(['stop-file-set']);
      expect(logged()).toMatch(/^STOP set: lanes halt between issues/);
      await runMain('resume');
      expect(types()).toEqual(['stop-file-set', 'stop-file-cleared']);
    });

    it('stop --json fails with exit 2 and writes nothing when repo lookup fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('stop', '--json');
      expect(res).toMatchObject({ exited: true, code: 2 });
      expect(errored()).toContain('no GitHub remote detected');
      expect(logged()).toBe('');
      expect(existsSync(paths().stop)).toBe(false);
    });
  });

  describe('proxy', () => {
    it('starts the foreground proxy, prints routes, and shuts down cleanly on SIGINT', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: true, port: 0, domain: 'factory.localhost' } },
      };
      writeFileSync(
        join(paths().state, 'ports.json'),
        JSON.stringify({
          version: 1,
          leases: [
            {
              worktreeId: '/repo/ship-it-296',
              branch: 'ship-it/296',
              port: 3142,
              pid: process.pid,
              acquiredAt: new Date().toISOString(),
            },
          ],
        }),
      );

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(logged()).toContain('ship-it-296.factory.localhost -> 127.0.0.1:3142');
      expect(existsSync(join(paths().state, 'proxy.json'))).toBe(false);
    });

    it('warns but still starts when environment.proxy.enabled is false (the command is the explicit opt-in)', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        environment: { proxy: { enabled: false, port: 0, domain: 'factory.localhost' } },
      };

      const runPromise = runMain('proxy');
      while (!logged().includes('listening on')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain('explicit opt-in');
      process.emit('SIGINT');
      await runPromise;
    });
  });

  describe('daemon', () => {
    it('starts the foreground factoryd, serves the registry, and shuts down cleanly on SIGINT', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(
        registryFile,
        JSON.stringify({
          version: 1,
          repos: {
            'on-par/software-factory': {
              path: h.repoRoot,
              attachedAt: '2026-01-01T00:00:00.000Z',
              state: 'active',
            },
          },
        }),
      );

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(registryFile);

      // Runtime state lives in dirname(registryFile) while the daemon is up (#1177).
      const pidFile = join(paths().state, 'daemon.pid');
      const portFile = join(paths().state, 'daemon.port');
      const logFile = join(paths().state, 'daemon.log');
      const boundPort = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(logged())![1]);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
      expect(JSON.parse(readFileSync(portFile, 'utf-8'))).toEqual({
        pid: process.pid,
        port: boundPort,
        host: '127.0.0.1',
      });

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
      expect(existsSync(pidFile)).toBe(false);
      expect(existsSync(portFile)).toBe(false);
      expect(readFileSync(logFile, 'utf-8')).toContain(`factoryd: listening on 127.0.0.1:${boundPort}`);
    });

    it('daemon run --help lists --update-mode and the deprecated --auto-update', async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      const written: string[] = [];
      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('daemon', 'run', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }

      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--update-mode');
      expect(text).toContain('manual, stable');
      expect(text).toContain('--auto-update');
      expect(text).toContain('Deprecated');
    });

    it('accepts --auto-update and starts and stops exactly like the default run', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));

      const runPromise = runMain('daemon', 'run', '--auto-update', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }

      process.emit('SIGINT');
      const res = await runPromise;

      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });

    it('exits with code 2 on an invalid --port and never binds', async () => {
      const res = await runMain('daemon', 'run', '--port', 'abc');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    it('exits with code 2 on --update-mode nightly and lists the valid modes', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const res = await runMain('daemon', 'run', '--update-mode', 'nightly', '--registry', registryFile);
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(logged()).not.toContain('listening on');
    });

    const bootout = { cmd: 'launchctl', args: ['bootout', `gui/501/${FACTORYD_LABEL}`] };
    const print = { cmd: 'launchctl', args: ['print', `gui/501/${FACTORYD_LABEL}`] };

    it('daemon start installs the plist and bootstraps it through launchctl', async () => {
      const { plistPath } = factorydFiles(h.daemonHome);
      let prints = 0;
      h.daemonExecImpl = (_cmd, args) =>
        args[0] === 'print' && prints++ === 0
          ? { code: 113, stdout: '', stderr: 'Could not find service' }
          : { code: 0, stdout: '', stderr: '' };
      const res = await runMain('daemon', 'start');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([
        bootout,
        print,
        { cmd: 'launchctl', args: ['bootstrap', 'gui/501', plistPath] },
        print,
      ]);
      expect(existsSync(plistPath)).toBe(true);
      expect(readFileSync(plistPath, 'utf-8')).toContain('/opt/factory/cli.js');
      expect(h.daemonOut.join('')).toContain('factoryd: installed');
    });

    it('daemon stop boots the agent out through launchctl', async () => {
      const res = await runMain('daemon', 'stop');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([bootout]);
      expect(h.daemonOut.join('')).toContain('factoryd: stopped');
    });

    it('daemon status reports the pid and uptime of the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(false);
      expect(h.daemonExecCalls).toEqual([print, { cmd: 'ps', args: ['-o', 'etime=', '-p', '4242'] }]);
      const out = h.daemonOut.join('');
      expect(out).toContain('factoryd: running (pid 4242, uptime 01:02)');
      expect(out).toContain('attached repos: none');
    });

    it('daemon status --json prints one JSON object for the running agent', async () => {
      h.daemonExecImpl = (cmd) =>
        cmd === 'launchctl'
          ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
          : { code: 0, stdout: '01:02\n', stderr: '' };
      const res = await runMain('daemon', 'status', '--json');
      expect(res.exited).toBe(false);
      expect(JSON.parse(h.daemonOut.join(''))).toEqual({
        schemaVersion: 1,
        running: true,
        pid: 4242,
        uptimeSec: 62,
        plistInstalled: false,
        repos: [],
        load: expect.objectContaining({ maxSlots: expect.any(Number) }),
      });
    });

    it('daemon status (plain text) on linux exits 2 with nothing on stdout', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status');
      expect(res.code).toBe(2);
      expect(h.daemonOut).toEqual([]);
      expect(errored()).toContain('requires macOS launchd');
    });

    it('daemon logs -n prints the last N lines of the log', async () => {
      const { logPath } = factorydFiles(h.daemonHome);
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, Array.from({ length: 10 }, (_, i) => `line${i + 1}\n`).join(''));
      const res = await runMain('daemon', 'logs', '-n', '3');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toBe('line8\nline9\nline10\n');
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('daemon logs -f returns early when no log exists yet', async () => {
      // Never create a log file here: follow mode would then block on SIGINT.
      const res = await runMain('daemon', 'logs', '-f', '-n', '7');
      expect(res.exited).toBe(false);
      expect(h.daemonOut.join('')).toContain('no daemon log yet');
    });

    it('maps DaemonCtlError onto the CLI exit code', async () => {
      h.daemonPlatform = 'linux';
      const res = await runMain('daemon', 'status');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(h.daemonExecCalls).toEqual([]);
    });

    it('refuses to start when a live daemon holds the pid file, leaving it untouched', async () => {
      const registryFile = join(paths().state, 'registry.json');
      const pidFile = join(paths().state, 'daemon.pid');
      // The test process itself is alive by construction.
      writeFileSync(pidFile, `${process.pid}\n`);

      const res = await runMain('daemon', 'run', '--port', '0', '--registry', registryFile);

      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(errored()).toContain(`factoryd already running (pid ${process.pid})`);
      expect(readFileSync(pidFile, 'utf-8')).toBe(`${process.pid}\n`);
      expect(logged()).not.toContain('listening on');
    });

    it('a stale pid file from a killed daemon does not block a restart', async () => {
      const registryFile = join(paths().state, 'registry.json');
      writeFileSync(registryFile, JSON.stringify({ version: 1, repos: {} }));
      const pidFile = join(paths().state, 'daemon.pid');
      // A real (bypassing the module mock) short-lived child yields a pid that
      // is guaranteed dead once spawnSync returns.
      const { spawnSync } = await vi.importActual<typeof ChildProcess>('node:child_process');
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      writeFileSync(pidFile, `${deadPid}\n`);

      const runPromise = runMain('daemon', 'run', '--port', '0', '--registry', registryFile);
      while (!logged().includes('listening on 127.0.0.1:')) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(logged()).toContain(`removed stale pid file (pid ${deadPid})`);
      expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));

      process.emit('SIGINT');
      const res = await runPromise;
      expect(res.exited).toBe(true);
      expect(res.code).toBe(0);
    });
  });

  describe('worktree gc', () => {
    it('dry-run calls sweepWorktrees with dryRun: true and takes no lock', async () => {
      h.gcReport = { removed: [], kept: 3, dryRun: true };
      const lockHeld: boolean[] = [];
      ops.sweepWorktrees.mockImplementationOnce(async () => {
        lockHeld.push(existsSync(paths().gitLock));
        return h.gcReport;
      });
      const res = await runMain('worktree', 'gc', '--dry-run');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, dryRun: true }),
        expect.anything(),
      );
      expect(lockHeld).toEqual([false]);
      expect(logged()).toContain('GC_REPORT:dry:removed=0:kept=3');
    });

    it('--ttl-days overrides the config default', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', '3');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(expect.objectContaining({ ttlDays: 3 }), expect.anything());
    });

    it('--branch-prefix sf is passed to sweepWorktrees', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ branchPrefix: 'sf' }),
        expect.anything(),
      );
    });

    it('run.branchPrefix in the repo config is the default, and --branch-prefix beats it', async () => {
      h.factoryConfig = { ...h.factoryConfig, run: { branchPrefix: 'Acme Bots' } };
      expect((await runMain('worktree', 'gc')).exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenLastCalledWith(
        expect.objectContaining({ branchPrefix: 'acme-bots' }),
        expect.anything(),
      );
      expect((await runMain('worktree', 'gc', '--branch-prefix', 'sf')).exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenLastCalledWith(
        expect.objectContaining({ branchPrefix: 'sf' }),
        expect.anything(),
      );
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('worktree', 'gc', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('exits 2 on a non-numeric --ttl-days', async () => {
      const res = await runMain('worktree', 'gc', '--ttl-days', 'nope');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--ttl-days');
    });
  });

  describe('reset', () => {
    it('prints one summary line per issue and exits 0 when nothing is found', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '556');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555: nothing to reset');
      expect(logged()).toContain('#556: nothing to reset');
      expect(lockHeld).toContain(true);
    });

    it('--dry-run previews without taking the git lock', async () => {
      const lockHeld: boolean[] = [];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        lockHeld.push(existsSync(paths().gitLock));
        return '';
      };
      const res = await runMain('reset', '555', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('#555 (dry run): nothing to reset');
      expect(lockHeld.length).toBeGreaterThan(0);
      expect(lockHeld.every((held) => !held)).toBe(true);
    });

    it('runs the dirty probe through exec and keeps a dirty worktree (#1789)', async () => {
      const wt = join(h.repoRoot, '..', 'wt-777');
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('worktree list')) return `worktree ${wt}\nHEAD abc\nbranch refs/heads/factory/777-x\n`;
        if (cmd.includes('git status')) return ' M a.ts\n';
        return '';
      };
      const res = await runMain('reset', '777', '--dry-run');
      expect(res.exited).toBe(false);
      expect(logged()).toContain(`would keep worktree ${wt} (uncommitted changes; pass --force to remove)`);
      expect(logged()).not.toContain('would remove worktree');
    });

    it('exits 2 on a non-numeric issue', async () => {
      const res = await runMain('reset', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('expected a positive integer issue number');
    });

    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('reset', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
    });
  });

  describe('local-small-dry-run', () => {
    it('creates the dry-run plan and context and prints their paths', async () => {
      const res = await runMain('local-small-dry-run', '5');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('/tmp/plan.md');
      expect(out).toContain('/tmp/ctx.md');
    });
  });

  describe('local-small-overnight', () => {
    it('exits 2 mentioning the expected path when the queue file is missing', async () => {
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain(join(paths().state, 'local-small', 'overnight-queue'));
    });

    it('exits 2 when the queue file has only malformed lines', async () => {
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'not a valid line\n');
      const res = await runMain('local-small-overnight');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('malformed');
    });

    it('runs the happy path: ships the queued issue and records it as ready', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight ready: 1');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'ready' })]);
    });

    it('exits 4 mentioning halted when preflight fails', async () => {
      h.claudeAvailable = false;
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('halted');
    });

    it('exits 4 mentioning no reachable local worker when no worker-tier model is reachable', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: false, experimental: false, reason: 'no key' },
      ];
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res).toEqual({ exited: true, code: 4 });
      expect(errored()).toContain('no reachable local worker model');
    });

    it('parks an item, reports it, and logs overnight-park when shipIssue escalates', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.planResult = { ok: false, route: 'claude', escalate: 'needs human' };
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      expect(logged()).toContain('parked');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('overnight-park');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });

    // Regression (#681): the curated overnight queue needs a human to prune it —
    // a closed issue maps to 'parked', not 'ready' or 'failed'.
    it('parks a closed issue for a human, reports it, and logs overnight-park', async () => {
      h.diagnoses = [
        { model: 'w', provider: 'openai', tiers: ['worker'], reachable: true, experimental: false, reason: 'ok' },
      ];
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const queueDir = join(paths().state, 'local-small');
      mkdirSync(queueDir, { recursive: true });
      writeFileSync(join(queueDir, 'overnight-queue'), 'overnight 5\n');

      const res = await runMain('local-small-overnight');

      expect(res.exited).toBe(false);
      expect(logged()).toContain('overnight parked: 1');
      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('skipped-already-closed');

      const state = JSON.parse(readFileSync(join(queueDir, 'overnight-state.json'), 'utf-8'));
      expect(state.items).toEqual([expect.objectContaining({ issue: 5, status: 'parked' })]);
    });
  });

  describe('resume-approved', () => {
    it('exits 2 when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('resume-approved', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
    });

    it('resolves cleanly when there are no open factory PRs', async () => {
      const res = await runMain('resume-approved');
      expect(res.exited).toBe(false);
      expect(errored()).toBe('');
    });

    it('exits 5 and reports failed PRs when landing an approved PR fails', async () => {
      h.octokit.graphql = vi.fn(async (query: string) => {
        if (query.includes('OpenFactoryPRs')) {
          return {
            repository: {
              pullRequests: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  { number: 12, headRefName: 'factory/5-fix-the-bug', reviewDecision: 'APPROVED', isDraft: false },
                ],
              },
            },
          };
        }
        return {};
      });
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('issue vanished');
      });
      const res = await runMain('resume-approved');
      expect(res).toEqual({ exited: true, code: 5 });
      expect(logged()).toContain('failed to land');
      expect(errored()).toContain('1 PR(s) failed to land');
    });
  });

  describe('ship (via cmdShip)', () => {
    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('ship', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });

    it('exits 2 before any phase runs when --branch-prefix has no letters or digits', async () => {
      const res = await runMain('ship', '5', '--branch-prefix', '!!!');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');
      expect(phases.planPhase).not.toHaveBeenCalled();
    });
    it('ships an issue through all phases and prints the ready PR', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
    });

    it('reports already-delivered instead of "ready for review" when SHIP recovery finds a prior merged PR (#520)', async () => {
      h.shipResult = { ok: true, prNumber: 518, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered by merged PR #518');
      expect(logged()).not.toContain('PR #518 ready for review');
    });

    it('reports the branch as already landed on main when SHIP recovery finds no merged PR for it (#520)', async () => {
      h.shipResult = { ok: true, alreadyDelivered: true };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('already delivered — branch already landed on main');
      expect(logged()).not.toContain('PR #undefined');
    });

    it('prints a yellow SKIP line for a skipped checker while the run still succeeds', async () => {
      h.checkResult = {
        passed: true,
        summary: {
          results: [
            {
              checker: 'tests',
              result: 'SKIP',
              details: 'no verification command was run — no scripts/verify.sh and no package.json test script found',
            },
          ],
          failures: 0,
        },
        reworkRounds: 0,
      };
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('SKIP: tests');
    });

    it('exits 1 and logs a park event when a check fails', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('exits 1 and logs exactly one park event when a check fails under FACTORY_LOCAL_ONLY=1', async () => {
      trackEnv('FACTORY_LOCAL_ONLY');
      process.env.FACTORY_LOCAL_ONLY = '1';
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const failEvents = events.filter((e: any) => e.type === 'fail' && e.issue === '5');
      expect(failEvents).toHaveLength(1);
      expect(errored()).toContain('Ship failed');
    });

    it('reaches shipPhase without an approval gate when --interactive is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
    });

    it('passes an approval gate to shipPhase when --interactive is set', async () => {
      const res = await runMain('ship', '5', '--interactive');
      expect(res.exited).toBe(false);
      const call = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
    });

    it('reaches planPhase without an approval gate when --approve-plan is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(call.approvalGate).toBeUndefined();
      expect(call.enforceReadiness).toBe(true);
      expect(call?.enforceSizeGate).toBe(true);
      expect(call.drainSteering).toBeUndefined();
    });

    it('passes an approval gate and drainSteering to planPhase when --approve-plan is set', async () => {
      const res = await runMain('ship', '5', '--approve-plan');
      expect(res.exited).toBe(false);
      const call = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(typeof call.approvalGate).toBe('function');
      expect(typeof call.drainSteering).toBe('function');
    });

    it('passes the agent prerequisite with only the codex CLI on PATH (#1269)', async () => {
      coreFakes.isCommandAvailable.mockImplementation((c: string) => c === 'codex' || c === 'git' || c === 'gh');
      const res = await runMain('ship', '5');
      expect(errored()).not.toContain('no coding agent CLI');
      expect(errored()).not.toContain('claude CLI not found');
      expect(phases.planPhase).toHaveBeenCalled();
      expect(!res.exited || res.code !== 2).toBe(true);
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('ship', '42');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('ship', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('parses --no-sandbox to opts.sandbox === false and logs sandbox disabled by the CLI flag', async () => {
      const res = await runMain('ship', '5', '--no-sandbox');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('sandbox disabled by --no-sandbox — agent runs are UNCONTAINED');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(true);
    });

    it('defaults --sandbox to true (no CLI-disabled event) when the flag is not passed', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('sandbox disabled by --no-sandbox');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'sandbox-disabled' && e.msg.includes('--no-sandbox'))).toBe(false);
    });

    it('warns that FACTORY_MERGE does not apply to ship and names factory land/run (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE=1 ignored');
      expect(errored()).toContain('factory land 5');
      expect(errored()).toContain('factory run');
      expect(logged()).toContain('PR #99 ready for review');
    });

    it('records the ignored-merge notice as a warn event (#978)', async () => {
      process.env.FACTORY_MERGE = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const warnEvents = events.filter((e: any) => e.type === 'warn' && e.issue === '5' && e.msg.includes('ignored'));
      expect(warnEvents).toHaveLength(1);
    });

    it('warns for FACTORY_MERGE_ADMIN alone (#978)', async () => {
      process.env.FACTORY_MERGE_ADMIN = '1';
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).toContain('FACTORY_MERGE_ADMIN=1 ignored');
    });

    it('prints no merge notice when neither variable is set (#978)', async () => {
      const res = await runMain('ship', '5');
      expect(res.exited).toBe(false);
      expect(errored()).not.toContain('ignored —');
      const events = readFileSync(paths().events, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events.some((e: any) => e.type === 'warn' && e.msg.includes('ignored'))).toBe(false);
    });
  });

  describe('run-issue (one-shot)', () => {
    it.each(['ship', 'run-issue'])(
      '%s refuses a pull request number before any model or plan call (#2492)',
      async (cmd) => {
        h.octokit.rest.issues.get = vi.fn(async () => ({
          data: { title: 'Add subtract (#1)', body: 'Closes #1', pull_request: { url: 'x' } },
        }));
        const routerRun = vi.fn(h.routerRun);
        h.routerRun = routerRun;
        const res = await runMain(cmd, '2');
        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('#2 is a pull request, not an issue. Did you mean issue #1?');
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(routerRun).not.toHaveBeenCalled();
      },
    );

    it('runs worktree gc before shipping when worktree.autoGcOnRun is true (#1756)', async () => {
      h.factoryConfig = { ...h.factoryConfig, worktree: { parent: '../', gcTtlDays: 7, autoGcOnRun: true } };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).toHaveBeenCalledWith(
        expect.objectContaining({ repoRoot: h.repoRoot, ttlDays: 7, repo: h.ghRepo }),
        expect.objectContaining({ octokit: expect.anything() }),
      );
      expect(ops.formatGcReport).toHaveBeenCalled();
    });

    it('does not run worktree gc when worktree.autoGcOnRun is false (#1756)', async () => {
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(ops.sweepWorktrees).not.toHaveBeenCalled();
    });

    describe('--size-gate (#2048)', () => {
      const enforced = () => phases.planPhase.mock.calls.at(-1)?.[0].enforceSizeGate;

      it('enforces the size gates with no config and no flag', async () => {
        await runMain('run-issue', '5');
        expect(enforced()).toBe(true);
      });

      it('skips the size gates when sizeGate.mode is off in the config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'off' } };
        await runMain('run-issue', '5');
        expect(enforced()).toBe(false);
      });

      it('--size-gate off beats a file config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'file' } };
        await runMain('run-issue', '5', '--size-gate', 'off');
        expect(enforced()).toBe(false);
      });

      it('--size-gate file beats an off config', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'off' } };
        await runMain('run-issue', '5', '--size-gate', 'file');
        expect(enforced()).toBe(true);
      });

      it('--size-gate slice passes sizeGateMode slice to planPhase', async () => {
        await runMain('run-issue', '5', '--size-gate', 'slice');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('slice');
      });

      it('sizeGate.mode slice in the config passes sizeGateMode slice to planPhase', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'slice' } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('slice');
      });

      it('sizeGate.mode stack in the config passes sizeGateMode stack to planPhase', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'stack' } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].sizeGateMode).toBe('stack');
      });

      it('--max-slices 6 passes maxSlices 6 to planPhase (ADR-0156)', async () => {
        await runMain('run-issue', '5', '--size-gate', 'slice', '--max-slices', '6');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(6);
      });

      it('sizeGate.maxSlices in the config is used when the flag is absent', async () => {
        h.factoryConfig = { ...h.factoryConfig, sizeGate: { mode: 'slice', maxSlices: 7 } };
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(7);
      });

      it('defaults maxSlices to 10 with neither flag nor config', async () => {
        await runMain('run-issue', '5');
        expect(phases.planPhase.mock.calls.at(-1)?.[0].maxSlices).toBe(10);
      });

      it.each(['0', '21', '2.5', 'abc', ''])('rejects --max-slices %j with exit 2 before planning', async (value) => {
        const res = await runMain('run-issue', '5', '--max-slices', value);
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--max-slices');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('rejects an unknown mode with exit 2 before planning', async () => {
        const res = await runMain('run-issue', '5', '--size-gate', 'bogus');
        expect(res).toMatchObject({ exited: true, code: 2 });
        expect(errored()).toContain('--size-gate');
        expect(errored()).toContain('file');
        expect(errored()).toContain('off');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('--help lists --size-gate', async () => {
        const originalWrite = process.stdout.write;
        const written: string[] = [];
        process.stdout.write = ((chunk: string | Uint8Array) => {
          written.push(String(chunk));
          return true;
        }) as typeof process.stdout.write;
        try {
          await runMain('run-issue', '--help');
        } finally {
          process.stdout.write = originalWrite;
        }
        expect(written.join('')).toContain('--size-gate');
        expect(written.join('')).toContain('slice');
      });
    });

    it('--help lists --run-children with its one-line description (#1750)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('run-issue', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--run-children');
      expect(text).toContain('File mode only: when the size gate files child issues, run them');
    });

    it('names the branch with the default factory prefix when --branch-prefix is omitted', async () => {
      const branches: string[] = [];
      h.setupWorktreeImpl = async (_r, branch) => {
        branches.push(branch);
      };
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(branches[0]).toEqual('factory/5-fix-the-bug');
    });

    it('names the branch and worktree with --branch-prefix sf', async () => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-issue', '5', '--branch-prefix', 'sf');
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toEqual('sf/5-fix-the-bug');
      expect(calls[0][1]).toContain('-factory-sf-');
    });
    it('names the child issues and suggests --run-children when the size gate decomposes the issue', async () => {
      h.planResult = { ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: [10, 11] } };
      const res = await runMain('run-issue', '5');
      expect(res).toMatchObject({ exited: true, code: 1 });
      expect(errored()).toContain('#10');
      expect(errored()).toContain('#11');
      expect(errored()).toContain('--run-children');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('accepts --run-children and ships a non-decomposed issue exactly as without it', async () => {
      const res = await runMain('run-issue', '5', '--run-children');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
    });

    describe('--run-children', () => {
      const decompose = (children: number[]) =>
        ({ ok: false, route: 'claude', escalate: 'decomposed', decomposed: { childIssues: children } }) as any;

      it('runs children in order, prints the summary, takes no labels/merge, and holds the lock', async () => {
        const { existsSync } = await import('node:fs');
        const childLocks = [10, 11].map((n) => join(paths().state, 'locks', 'run', String(n)));
        writeFileSync(paths().queue, 'app 7\n');
        const lockSeen: boolean[] = [];
        const recordLock = async () => {
          lockSeen.push(existsSync(childLocks[lockSeen.length] as string));
          return h.planResult;
        };
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(recordLock)
          .mockImplementationOnce(recordLock);
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 101 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 102 } as any);
        h.octokit.rest.issues.addLabels = vi.fn(async () => ({}));

        const res = await runMain('run-issue', '5', '--run-children');

        expect(res.exited).toBe(false);
        const issues = h.octokit.rest.issues.get.mock.calls.map((c: any[]) => c[0].issue_number);
        expect(issues.slice(0, 3)).toEqual([5, 10, 10]);
        expect(phases.planPhase).toHaveBeenCalledTimes(3);
        expect(phases.buildPhase).toHaveBeenCalledTimes(2);
        expect(phases.checkPhase).toHaveBeenCalledTimes(2);
        expect(phases.shipPhase).toHaveBeenCalledTimes(2);
        expect(h.octokit.rest.issues.addLabels).not.toHaveBeenCalled();
        expect(h.octokit.rest.pulls.merge).not.toHaveBeenCalled();
        expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\n');
        expect(logged()).toContain('#10 → PR #101 ready for review');
        expect(logged()).toContain('#11 → PR #102 ready for review');
        expect(logged()).toContain('2/2 children ready for review');
        expect(lockSeen).toEqual([true, true]);
        expect(childLocks.some((l) => existsSync(l))).toBe(false);
      });

      it('continues past a failed child and exits 1', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11, 12]));
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 101 } as any)
          .mockResolvedValueOnce({ ok: false } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 112 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#11 → failed');
        expect(logged()).toContain('#12 → PR #112 ready for review');
        expect(logged()).toContain('2/3 children ready for review');
        expect(phases.planPhase).toHaveBeenCalledTimes(4);
      });

      it('an escalated child does not stop later children', async () => {
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(async () => ({ ok: false, route: 'claude', escalate: 'needs human' }) as any);
        phases.shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#10 → failed');
        expect(logged()).toContain('#11 → PR #111 ready for review');
      });

      it('stops starting children once .factory/STOP appears, and leaves STOP in place', async () => {
        const stopPath = join(paths().state, 'STOP');
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockImplementationOnce(async () => {
          writeFileSync(stopPath, '');
          return { ok: true, prNumber: 110 } as any;
        });
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(phases.shipPhase).toHaveBeenCalledTimes(1);
        expect(phases.planPhase).toHaveBeenCalledTimes(2);
        expect(logged()).toContain('#10 → PR #110 ready for review');
        expect(logged()).toContain('#11 → not run: .factory/STOP present');
        expect(readFileSync(stopPath, 'utf-8')).toBe('');
      });

      it('runs a nested decomposition in place of the child, before later siblings', async () => {
        phases.planPhase
          .mockImplementationOnce(async () => decompose([10, 11]))
          .mockImplementationOnce(async () => decompose([20, 21]));
        phases.shipPhase
          .mockResolvedValueOnce({ ok: true, prNumber: 120 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 121 } as any)
          .mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res.exited).toBe(false);
        const issues = h.octokit.rest.issues.get.mock.calls.map((c: any[]) => c[0].issue_number);
        expect(issues.slice(0, 5)).toEqual([5, 10, 20, 20, 21]);
        expect(phases.planPhase).toHaveBeenCalledTimes(5);
        expect(phases.shipPhase).toHaveBeenCalledTimes(3);
        expect(logged()).toContain('#10 → decomposed into #20, #21');
        expect(logged()).toContain('3/3 children ready for review');
      });

      const closeIssue10 = () => {
        const get = h.octokit.rest.issues.get;
        h.octokit.rest.issues.get = vi.fn(async (args: any) => {
          const res = await get(args);
          return args.issue_number === 10 ? { ...res, data: { ...res.data, state: 'closed' } } : res;
        });
      };

      it('skips a closed child, keeps going, and exits 0', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockResolvedValueOnce({ ok: true, prNumber: 111 } as any);
        closeIssue10();
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res.exited).toBe(false);
        expect(phases.shipPhase).toHaveBeenCalledTimes(1);
        expect(logged()).toContain('#10 → skipped:');
        expect(logged()).toContain('#11 → PR #111 ready for review');
        expect(logged()).toContain('1/2 children ready for review, 1 skipped');
      });

      it('still exits 1 when a child after a skipped one fails', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10, 11]));
        phases.shipPhase.mockResolvedValueOnce({ ok: false } as any);
        closeIssue10();
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('#10 → skipped:');
        expect(logged()).toContain('#11 → failed');
      });

      it('records a child that cannot be resolved as failed', async () => {
        phases.planPhase.mockImplementationOnce(async () => decompose([10]));
        const get = h.octokit.rest.issues.get;
        h.octokit.rest.issues.get = vi.fn(async (args: any) => {
          if (args.issue_number === 10) throw new Error('Not Found');
          return get(args);
        });
        const res = await runMain('run-issue', '5', '--run-children');
        expect(res).toMatchObject({ exited: true, code: 1 });
        expect(logged()).toContain('could not resolve issue #10');
      });
    });

    it('resolves the issue through the canonical work-request seam and ships it through all phases', async () => {
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(logged()).toContain(`github-issue:${h.ghRepo}#5`);
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.get).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 5 }));
    });

    // Regression (#681): a closed issue exits 0 (not 1) through the CLI command,
    // reusing the ctx.workRequest resolved by this command's own preflight.
    it('exits 0 on a closed issue instead of failing', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => ({ data: { title: 'Fix the bug', state: 'closed' } }));
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('skipped:');
      expect(h.octokit.rest.issues.get).toHaveBeenCalledTimes(1);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const res = await runMain('run-issue', '5');
      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('rejects a non-numeric identifier before any work', async () => {
      const res = await runMain('run-issue', 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
    });

    it('rejects a zero identifier before any work', async () => {
      const res = await runMain('run-issue', '0');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid issue argument');
    });

    it('fails pre-flight with exit 2 when the issue is unreachable — no worktree, no PR', async () => {
      h.octokit.rest.issues.get = vi.fn(async () => {
        throw new Error('Not Found');
      });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve issue #5');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for issue #5');
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('reports invalid work-request input as a pre-flight error, not a generic resolve failure', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return 'not-a-valid-repo-slug';
        return '';
      };
      const res = await runMain('run-issue', '5');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('invalid input for work-request source');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });
  });

  describe('run-brief (one-shot)', () => {
    const VALID_BRIEF = `# Add a widget

Please add a widget that does the thing.

## Acceptance criteria

- the widget exists
`;

    function writeBrief(content = VALID_BRIEF): string {
      const briefPath = join(h.repoRoot, 'brief.md');
      writeFileSync(briefPath, content);
      return briefPath;
    }

    function readEventLines(): any[] {
      return readFileSync(paths().events, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }

    const workspaceDirs: string[] = [];

    function writeWorkspace(): string {
      const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
      mkdirSync(join(ws, '.git'));
      workspaceDirs.push(ws);
      return ws;
    }

    it.each([
      [[], /^factory\//, false],
      [['--branch-prefix', 'sf'], /^sf\//, true],
    ] as const)('creates the worktree branch for prefix args %j', async (extra, pattern, sf) => {
      const calls: string[][] = [];
      h.setupWorktreeImpl = async (_r, branch, worktree) => {
        calls.push([branch, worktree]);
      };
      const res = await runMain('run-brief', writeBrief(), ...extra);
      expect(res.exited).toBe(false);
      expect(calls[0][0]).toMatch(pattern);
      if (sf) expect(calls[0][1]).toContain('-factory-sf-');
    });

    afterEach(() => {
      for (const ws of workspaceDirs.splice(0)) rmSync(ws, { recursive: true, force: true });
    });

    it('resolves the brief through the canonical work-request seam and ships it through all phases', async () => {
      const briefPath = writeBrief();
      const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(logged()).toContain('PR #99 ready for review');
      expect(logged()).toContain('local-brief:');
      expect(phases.planPhase).toHaveBeenCalledTimes(1);
      expect(phases.buildPhase).toHaveBeenCalledTimes(1);
      expect(phases.checkPhase).toHaveBeenCalledTimes(1);
      expect(phases.shipPhase).toHaveBeenCalledTimes(1);
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(vi.mocked(setupWorktree)).toHaveBeenCalled();

      const planArgs = phases.planPhase.mock.calls.at(-1)?.[0] as any;
      expect(planArgs.workSource).toEqual({ kind: 'local-brief', params: { path: briefPath } });

      const buildArgs = phases.buildPhase.mock.calls.at(-1)?.[0] as any;
      expect(buildArgs.disablePublish).toBeFalsy();

      const shipArgs = phases.shipPhase.mock.calls.at(-1)?.[0] as any;
      expect(shipArgs.work).toMatchObject({ kind: 'local-brief' });

      const events = readFileSync(paths().events, 'utf-8');
      expect(events).toContain('inline local brief');
      expect(events).toContain(digest);

      const workSourceEvent = readEventLines().find((e) => e.type === 'work-source');
      expect(workSourceEvent.issue).toMatch(/^9\d{6}$/);
    });

    it('leaves the queue file untouched', async () => {
      writeFileSync(paths().queue, 'app 7\ndocs 9\n');
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res.exited).toBe(false);
      expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
    });

    it('fails pre-flight with exit 2 on a malformed brief — no worktree, no BUILD', async () => {
      const briefPath = writeBrief('# Add a widget\n\nPlease add a widget that does the thing.\n');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no acceptance criteria');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
    });

    it('fails pre-flight with exit 2 when the brief file is missing — no worktree, no PR', async () => {
      const briefPath = join(h.repoRoot, 'does-not-exist.md');

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('could not resolve brief');
      expect(errored()).toContain('no worktree or PR was created');
      expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
      expect(phases.planPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the missing-agent message and never invokes the phase mocks when no agent CLI is available', async () => {
      h.claudeAvailable = false;
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('no coding agent CLI found on PATH');
      expect(phases.planPhase).not.toHaveBeenCalled();
      expect(phases.buildPhase).not.toHaveBeenCalled();
      expect(phases.checkPhase).not.toHaveBeenCalled();
      expect(phases.shipPhase).not.toHaveBeenCalled();
    });

    it('exits 2 with the not-initialized message when .factory/ is missing', async () => {
      rmSync(paths().root, { recursive: true, force: true });
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('factory not initialized — run `factory init` first');
    });

    it('maps a pipeline failure to exit 1, not a pre-flight error', async () => {
      h.checkResult = {
        passed: false,
        summary: { results: [{ checker: 'lint', result: 'FAIL', details: 'bad' }], failures: 1 },
        reworkRounds: 2,
      };
      const briefPath = writeBrief();

      const res = await runMain('run-brief', briefPath);

      expect(res).toEqual({ exited: true, code: 1 });
      expect(errored()).toContain('Run failed for brief');
    });

    describe.each(['live file', 'rotated segment'])(
      'human-restarted when the prior park sits in the %s (#3711)',
      (where) => {
        it.each(['ship', 'run-issue', 'run-brief'])('%s', async (cmd) => {
          const digest = createHash('sha256').update(VALID_BRIEF).digest('hex');
          const issue =
            cmd === 'run-brief' ? String(9_000_000 + (Number.parseInt(digest.slice(0, 8), 16) % 1_000_000)) : '5';
          const fail = JSON.stringify({ ts: '2026-07-01T00:00:00.000Z', type: 'fail', issue, msg: 'checker failures' });
          if (where === 'live file') writeFileSync(paths().events, fail + '\n');
          else {
            mkdirSync(eventSegmentsDir(paths().events), { recursive: true });
            writeFileSync(join(eventSegmentsDir(paths().events), eventSegmentFileName(0)), fail + '\n');
          }
          const res = await runMain(cmd, cmd === 'run-brief' ? writeBrief() : '5');
          expect(res.exited).toBe(false);
          const events = readFileSync(paths().events, 'utf-8');
          expect(events).toContain('human-restarted');
          expect(events).toContain('manual retry of a previously parked/failed run');
        });
      },
    );

    describe('--workspace (local-only)', () => {
      it('runs PLAN/BUILD/CHECK in the caller workspace, disables publish, and skips SHIP', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
        expect(logged()).toContain('publishing disabled');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.shipPhase).not.toHaveBeenCalled();

        expect(phases.planPhase).toHaveBeenCalledTimes(1);
        expect(phases.buildPhase).toHaveBeenCalledTimes(1);
        expect(phases.checkPhase).toHaveBeenCalledTimes(1);
        expect(phases.planPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });
        expect(phases.buildPhase.mock.calls.at(-1)?.[0]).toMatchObject({
          worktree: ws,
          disablePublish: true,
        });
        expect(phases.checkPhase.mock.calls.at(-1)?.[0]).toMatchObject({ worktree: ws });

        expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();

        const events = readFileSync(paths().events, 'utf-8');
        expect(events).toContain('local-only');
        expect(events).toContain(ws);
      });

      it('needs no GitHub remote — getGitHubRepo is never called', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        h.execImpl = (cmd: string) => {
          if (cmd.includes('rev-parse')) return h.repoRoot;
          if (cmd.includes('gh repo view')) throw new Error('no GitHub remote configured');
          return '';
        };

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('Local-only run complete');
      });

      it('leaves the queue file byte-identical', async () => {
        writeFileSync(paths().queue, 'app 7\ndocs 9\n');
        const ws = writeWorkspace();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res.exited).toBe(false);
        expect(readFileSync(paths().queue, 'utf-8')).toBe('app 7\ndocs 9\n');
      });

      it('exits 2 before any pipeline call when the workspace is missing', async () => {
        const missing = join(tmpdir(), 'factory-ws-does-not-exist-xyz');
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', missing);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid local-only workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
        expect(phases.buildPhase).not.toHaveBeenCalled();
      });

      it('exits 2 before any pipeline call when the workspace has no .git', async () => {
        const ws = mkdtempSync(join(tmpdir(), 'factory-ws-'));
        workspaceDirs.push(ws);
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('not an initialized git repository');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });
    });

    describe('--artifacts (benchmark manifest)', () => {
      const artifactsDirs: string[] = [];

      function writeArtifactsDir(): string {
        const dir = mkdtempSync(join(tmpdir(), 'factory-artifacts-'));
        artifactsDirs.push(dir);
        return dir;
      }

      afterEach(() => {
        for (const dir of artifactsDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
      });

      it('writes a versioned manifest plus request/events/diff artifacts on a successful run', async () => {
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res.exited).toBe(false);
        expect(logged()).toContain('benchmark artifacts:');

        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.manifestVersion).toBe(1);
        expect(manifest.run.outcome).toBe('ready');
        expect(manifest.request.kind).toBe('local-brief');
        expect(manifest.phases.ship).toBe('skipped');

        expect(existsSync(join(artDir, 'request.json'))).toBe(true);
        expect(existsSync(join(artDir, 'events.ndjson'))).toBe(true);
        expect(existsSync(join(artDir, 'diff.patch'))).toBe(true);
      });

      it('writes a diagnosable manifest with a typed failure when CHECK fails', async () => {
        h.checkResult = {
          passed: false,
          summary: {
            failures: 1,
            passes: 0,
            skips: 0,
            total: 1,
            results: [{ checker: 'tests', result: 'FAIL', details: 'boom' }],
          },
          reworkRounds: 1,
        };
        const ws = writeWorkspace();
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 1 });
        const manifestPath = join(artDir, 'manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.run.outcome).toBe('failed');
        expect(manifest.failure).toMatchObject({ phase: 'check', reason: 'fail' });
        expect(manifest.artifacts.events).toBe('events.ndjson');
      });

      it('exits 2 with --artifacts requires --workspace when --workspace is absent', async () => {
        const artDir = writeArtifactsDir();
        const briefPath = writeBrief();

        const res = await runMain('run-brief', briefPath, '--artifacts', artDir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('--artifacts requires --workspace');
        expect(vi.mocked(setupWorktree)).not.toHaveBeenCalled();
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('exits 2 with invalid artifacts directory when the path is a regular file', async () => {
        const ws = writeWorkspace();
        const briefPath = writeBrief();
        const notADir = join(h.repoRoot, 'artifacts-file');
        writeFileSync(notADir, 'hello');

        const res = await runMain('run-brief', briefPath, '--workspace', ws, '--artifacts', notADir);

        expect(res).toEqual({ exited: true, code: 2 });
        expect(errored()).toContain('invalid artifacts directory');
        expect(phases.planPhase).not.toHaveBeenCalled();
      });

      it('writes no manifest for normal runs (no --artifacts)', async () => {
        const briefPathA = writeBrief();
        const resA = await runMain('run-brief', briefPathA);
        expect(resA.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');

        const ws = writeWorkspace();
        const briefPathB = writeBrief();
        const resB = await runMain('run-brief', briefPathB, '--workspace', ws);
        expect(resB.exited).toBe(false);
        expect(logged()).not.toContain('benchmark artifacts:');
      });
    });
  });

  describe('git/github detection failures', () => {
    it('exits 2 with "not inside a git repository" when git rev-parse fails', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) throw new Error('fatal: not a git repository');
        return '';
      };
      const res = await runMain('status');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('not inside a git repository');
    });

    it('falls back to `gh auth token` via execSync when no GITHUB_TOKEN/GH_TOKEN env var is set', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.factoryConfig = { ...h.factoryConfig, filing: { selfFixLabel: 'no-auto-merge', enabled: false } };
      h.execSyncImpl = (cmd: string) => {
        if (cmd.includes('gh auth token')) return 'gho_fallback_token\n';
        throw new Error('not stubbed');
      };
      const res = await runMain('land', '5');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('Landed PR #77');
    });
  });
});

// ===========================================================================
describe('CliExitError (direct command invocation)', () => {
  it('is a proper Error subclass carrying a code', () => {
    const err = new CliExitError('msg', 3);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliExitError');
    expect(err.message).toBe('msg');
    expect(err.code).toBe(3);
  });

  it('cmdConstitution({}) rejects with code 2 and the usage message', async () => {
    await expect(cmdConstitution({}, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('usage: factory constitution'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("cmdConstitution({ product: 'nope' }) rejects with code 1 and the not-found message", async () => {
    await expect(cmdConstitution({ product: 'nope' }, coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 1,
      message: expect.stringContaining("No constitution 'nope'"),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() rejects with code 2 when FACTORY_USAGE_CAP is invalid', async () => {
    trackEnv('FACTORY_USAGE_CAP');
    process.env.FACTORY_USAGE_CAP = '-5';
    await expect(cmdUsage(coreFakes)).rejects.toMatchObject({
      name: 'CliExitError',
      code: 2,
      message: expect.stringContaining('FACTORY_USAGE_CAP'),
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('cmdUsage() prints the real subscription usage plus the heuristic comparison when the subscription signal is available', async () => {
    h.subscriptionUsage = { fiveHourUtilization: 42, fiveHourResetsAt: '2026-07-15T18:00:00Z' };
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('5h subscription usage: 42% of plan limit, resets 2026-07-15T18:00:00Z');
    expect(logged).toContain('heuristic list-price estimate: USAGE REPORT');
  });

  it('cmdUsage() falls back to the heuristic with a warning when the subscription signal is unavailable', async () => {
    h.subscriptionUsage = null;
    await cmdUsage(coreFakes);
    const logged = logSpy.mock.calls.map((c: any[]) => c[0]).join('\n');
    expect(logged).toContain('real subscription usage unavailable');
    expect(logged).toContain('USAGE REPORT');
  });
});

// ===========================================================================
describe('parseIssueArg rejects unsafe integers across commands', () => {
  it.each([['ship'], ['run-issue'], ['queue', 'add', 'default'], ['reset']])(
    "'%s 9007199254740993' exits 2 before any GitHub work",
    async (...args) => {
      const res = await runMain(...args, '9007199254740993');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument '9007199254740993'");
      expect(errored()).toContain('expected a positive integer issue number');
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});

// ===========================================================================
describe('parseIssueArg wired into ship/land/local-small-dry-run', () => {
  it.each(['ship', 'land', 'local-small-dry-run'])(
    "'%s abc' fails before any GitHub or git work runs",
    async (command) => {
      const res = await runMain(command, 'abc');
      expect(res).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain("invalid issue argument 'abc'");
      expect(h.octokit.rest.issues.get).not.toHaveBeenCalled();
      expect(h.octokit.rest.pulls.list).not.toHaveBeenCalled();
    },
  );
});

// ===========================================================================
describe('factory --help layout', () => {
  async function topLevelHelp(): Promise<string> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const written: string[] = [];
    process.stdout.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const res = await runMain('--help');
      expect(res.exited).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
    return written.join('');
  }

  /** Command names listed under one heading, up to the next blank line. */
  function section(help: string, heading: string): string[] {
    const start = help.indexOf(`${heading}\n`);
    expect(start, `missing heading ${heading}`).toBeGreaterThanOrEqual(0);
    const body = help.slice(start + heading.length + 1).split('\n\n')[0];
    return body
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0].split('|')[0])
      .filter((name) => /^[a-z]/.test(name));
  }

  it('shows every group heading in table order, with no catch-all section', async () => {
    const help = await topLevelHelp();
    const positions = HELP_GROUPS.map((g) => help.indexOf(`${g.heading}\n`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(help).not.toContain(`${OTHER_GROUP}\n`);
    expect(help).not.toContain('Commands:\n');
  });

  it("lists each group's commands under its heading, in table order", async () => {
    const help = await topLevelHelp();
    for (const group of HELP_GROUPS) {
      const expected = group.includesHelp ? [...group.commands, 'help'] : [...group.commands];
      expect(section(help, group.heading)).toEqual(expected);
    }
  });

  it('puts run-issue, ship, run, and land under "Run work:"', async () => {
    const runWork = section(await topLevelHelp(), 'Run work:');
    expect(runWork).toEqual(expect.arrayContaining(['run-issue', 'ship', 'run', 'land']));
  });

  it('says ship opens a PR and never merges, and run-issue is ship with an up-front issue check', async () => {
    const help = (await topLevelHelp()).replace(/\s+/g, ' ');
    expect(help).toContain('open a ready-for-review PR; never merges (merge later with land)');
    expect(help).toContain('Like ship, but loads the issue first');
  });
});

describe('ghRepoViewFailureMessage (#2592)', () => {
  it.each([undefined, '', 'no git remotes found'])('keeps the no-remote message for %j', (stderr) => {
    expect(ghRepoViewFailureMessage(stderr)).toBe('factory: no GitHub remote detected (gh repo view failed)');
  });

  it('keeps the no-remote message when no remote points to a known GitHub host (#2594)', () => {
    const msg = ghRepoViewFailureMessage(
      'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n',
    );
    expect(msg).toBe('factory: no GitHub remote detected (gh repo view failed)');
    expect(msg).not.toContain('gh is not authenticated');
  });

  it('names gh authentication when gh says it is logged out', () => {
    const msg = ghRepoViewFailureMessage(
      'You are not logged into any GitHub hosts. Run gh auth login to authenticate.',
    );
    expect(msg).toContain('gh is not authenticated');
    expect(msg).toContain('`gh auth login`');
    expect(msg).not.toContain('no GitHub remote detected');
  });

  it.each([
    'HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login',
    'non-200 OK status code: 401 Unauthorized body: ...',
  ])('says the token was rejected and names the repo scope for %j', (stderr) => {
    const msg = ghRepoViewFailureMessage(stderr);
    expect(msg).toContain('rejected the token');
    expect(msg).toContain('`repo` scope');
    expect(msg).not.toContain('no GitHub remote detected');
    expect(msg).not.toContain('gh is not authenticated');
  });
});
