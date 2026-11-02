import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
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
});
