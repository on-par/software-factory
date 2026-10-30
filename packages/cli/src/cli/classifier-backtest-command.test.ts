import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  coreFakes,
  errored,
  h,
  installCliCommandsHarness,
  logged,
  paths,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('classifier backtest (#1728)', () => {
    async function captureOutput(...args: string[]) {
      const outWrite = process.stdout.write.bind(process.stdout);
      const errWrite = process.stderr.write.bind(process.stderr);
      const written: string[] = [];
      const sink = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stdout.write = sink;
      process.stderr.write = sink;
      try {
        const res = await runMain(...args);
        return { res, text: `${written.join('')}\n${errored()}`.replace(/\s+/g, ' ') };
      } finally {
        process.stdout.write = outWrite;
        process.stderr.write = errWrite;
      }
    }

    it('requires --since', async () => {
      const { res, text } = await captureOutput('classifier', 'backtest');
      expect(res.exited).toBe(true);
      expect(text).toContain("required option '--since <date>' not specified");
    });

    it('is listed under classifier --help', async () => {
      const { text } = await captureOutput('classifier', '--help');
      expect(text).toContain('backtest');
    });

    it('exits 2 on an invalid --since', async () => {
      const res = await runMain('classifier', 'backtest', '--since', 'yesterday');
      expect(res.exited).toBe(true);
      expect(res.code).toBe(2);
      expect(errored()).toContain("invalid --since 'yesterday'");
    });

    it('classifier backtest sets the router codex sandbox from config (#3830)', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' },
      };
      const labels = join(h.repoRoot, 'labels.csv');
      writeFileSync(labels, 'pr,class\n');
      await runMain('classifier', 'backtest', '--since', '2026-01-01', '--labels', labels);
      expect(vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value.setCodexSandbox).toHaveBeenCalledWith(
        'workspace-write',
      );
    });

    it('replays a merged PR through the wired deps and writes the JSONL file', async () => {
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'factory/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: mergedAt,
                  merge_commit_sha: 'abcdef1234567',
                  closed_at: null,
                },
              ],
            }
          : { data: [] },
      );
      h.octokit.rest.pulls.listCommits = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.listReviews = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.pulls.get = vi.fn(async () => ({ data: { merged_by: { login: 'patrob' } } }));
      h.octokit.rest.repos = { listCommits: vi.fn(async () => ({ data: [] })) };
      const execImpl = h.execImpl;
      h.execImpl = (cmd: string) => {
        if (cmd.startsWith('git diff --numstat')) return '1\t0\tdocs/a.md\n';
        if (cmd.startsWith('git diff')) return 'diff --git a/docs/a.md b/docs/a.md\n+hello\n';
        return execImpl(cmd);
      };
      writeFileSync(paths().events, `${JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' })}\n`);
      const labels = join(h.repoRoot, 'labels.csv');
      writeFileSync(labels, 'pr,class\n77,clean\n');

      const res = await runMain('classifier', 'backtest', '--since', '2026-01-01', '--labels', labels);

      expect(res.exited).toBe(false);
      expect(logged()).toContain('covered 1 of 1 PRs');
      const files = readdirSync(paths().state).filter((f) => f.startsWith('classifier-backtest-'));
      expect(files).toHaveLength(1);
      const record = JSON.parse(readFileSync(join(paths().state, files[0]), 'utf-8').trim());
      expect(record).toMatchObject({ prNumber: 77, labelSource: 'hand', outcomeLabel: 'clean' });
      expect(logged()).toContain(`Wrote ${join(paths().state, files[0])}`);
    });
  });
});
