import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  coreFakes,
  h,
  installCliCommandsHarness,
  paths,
  runMain,
  runMainWith,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('tui', () => {
    it('uses an injected deps.runTui instead of the real one, and the explicit argv wins over process.argv', async () => {
      const fake = vi.fn(async () => {});
      process.argv = ['node', 'factory'];
      const res = await runMainWith({ runTui: fake }, 'tui');
      expect(res.exited).toBe(false);
      expect(fake).toHaveBeenCalledTimes(1);
      expect(fake).toHaveBeenCalledWith(
        expect.objectContaining({
          eventsFile: expect.stringMatching(/\.factory[\\/]state[\\/]events\.ndjson$/),
          repo: h.ghRepo,
        }),
      );
      expect(h.runTuiCalls).toHaveLength(0);
    });

    it('tui sets the router codex sandbox from config (#3830)', async () => {
      h.factoryConfig = {
        ...h.factoryConfig,
        sandbox: { ...h.factoryConfig.sandbox, codexSandbox: 'workspace-write' },
      };
      await runMain('tui');
      expect(vi.mocked(coreFakes.ModelRouter).mock.results.at(-1)?.value.setCodexSandbox).toHaveBeenCalledWith(
        'workspace-write',
      );
    });

    it('calls runTui with the events file, detected repo, and a GitHub-backed queue reader by default', async () => {
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].eventsFile.endsWith(join('.factory', 'state', 'events.ndjson'))).toBe(true);
      expect(h.runTuiCalls[0].repo).toBe(h.ghRepo);
      expect(h.runTuiCalls[0].stopFile?.endsWith(join('.factory', 'state', 'STOP'))).toBe(true);
      expect(h.runTuiCalls[0].queueReader?.source).toBe('GitHub');
      expect(h.runTuiCalls[0].queueReader?.pollMs).toBe(30_000);
      expect(h.runTuiCalls[0].costsFile?.endsWith(join('.factory', 'state', 'costs.jsonl'))).toBe(true);
      expect(h.runTuiCalls[0].steeringDir?.endsWith(join('.factory', 'state', 'steering'))).toBe(true);
      expect(h.runTuiCalls[0].runsDir?.endsWith(join('.factory', 'state', 'runs'))).toBe(true);
    });

    it('default reader lists claimable GitHub issues with titles in lane order, ignoring a stale queue file (#1362)', async () => {
      writeFileSync(paths().queue, 'stale 1\nstale 2\nstale 3\n');
      const issues = [
        {
          number: 12,
          title: 'Second in cleanup',
          labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:2'],
        },
        {
          number: 11,
          title: 'First in cleanup',
          labels: ['factory:queued', 'factory:lane:cleanup', 'factory:order:1'],
        },
      ];
      const listForRepo = vi.fn(async ({ labels }: any) =>
        labels === 'factory:queued' ? { data: issues } : { data: [] },
      );
      h.octokit.rest.issues.listForRepo = listForRepo;

      await runMain('tui');
      expect(listForRepo).not.toHaveBeenCalled();

      const snapshot = await h.runTuiCalls[0].queueReader!.read();
      expect(snapshot).toEqual({
        entries: [
          { lane: 'cleanup', issue: 11, title: 'First in cleanup', status: 'queued' },
          { lane: 'cleanup', issue: 12, title: 'Second in cleanup', status: 'queued' },
        ],
      });
      expect(listForRepo).toHaveBeenCalledTimes(1);
    });

    it('--local-queue reads the queue file and its proposed count, and never calls GitHub (#1362)', async () => {
      writeFileSync(paths().queue, 'app 5\napp 6\n');
      writeFileSync(paths().queueProposed, 'app 7\n');
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      const res = await runMain('tui', '--local-queue');
      expect(res.exited).toBe(false);
      const reader = h.runTuiCalls[0].queueReader!;
      expect(reader.source).toBe('local file');
      expect(reader.pollMs).toBeUndefined();
      expect(await reader.read()).toEqual({
        entries: [
          { lane: 'app', issue: 5 },
          { lane: 'app', issue: 6 },
        ],
        proposedCount: 1,
      });
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it('without a GitHub token the default reader yields the no-token message and the TUI still starts', async () => {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      h.execSyncImpl = () => {
        throw new Error('gh not authenticated');
      };
      const listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listForRepo = listForRepo;

      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      const reader = h.runTuiCalls[0].queueReader!;
      expect(reader.source).toBe('GitHub');
      expect(await reader.read()).toEqual({ entries: [], error: 'no GitHub token — run `gh auth login`' });
      expect(listForRepo).not.toHaveBeenCalled();
    });

    it('surfaces a GitHub lookup failure as a rejected read the TUI renders, not a crash at startup', async () => {
      h.octokit.rest.issues.listForRepo = vi.fn(async () => {
        throw new Error('GitHub API unavailable');
      });
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      await expect(h.runTuiCalls[0].queueReader!.read()).rejects.toThrow('GitHub API unavailable');
    });

    it('--help lists --local-queue with the same wording as factory run (#1362)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('tui', '--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('').replace(/\s+/g, ' ');
      expect(text).toContain('--local-queue');
      expect(text).toContain('Read .factory/queue instead of claiming issues from GitHub Issues');
    });

    it('root --help ends with the env-var footer and the docs link', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const text = written.join('');
      expect(text.indexOf('Advanced / experimental:')).toBeLessThan(text.indexOf('Common environment variables:'));
      expect(text).toContain('docs/config.example.yaml');
      expect(text).toContain('factory <command> --help');
    });

    it('root --help names factory doctor as the first step on its first line (#2558)', async () => {
      const originalWrite = process.stdout.write;
      const written: string[] = [];
      process.stdout.write = ((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      let res: Awaited<ReturnType<typeof runMain>>;
      try {
        res = await runMain('--help');
      } finally {
        process.stdout.write = originalWrite;
      }
      expect(res.exited).toBe(true);
      const lines = written.join('').split('\n');
      expect(lines[0]).toContain('factory doctor');
      expect(lines[0]).toMatch(/first step/i);
      expect(lines.slice(0, 10).join('\n')).toContain('Prerequisites:');
    });

    it('calls runTui with repo undefined when gh repo detection fails, and the reader says so', async () => {
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) throw new Error('gh not authenticated');
        return '';
      };
      const res = await runMain('tui');
      expect(res.exited).toBe(false);
      expect(h.runTuiCalls).toHaveLength(1);
      expect(h.runTuiCalls[0].repo).toBeUndefined();
      expect(await h.runTuiCalls[0].queueReader!.read()).toEqual({
        entries: [],
        error: 'repo detection failed — run inside a GitHub-backed checkout',
      });
    });
  });
});
