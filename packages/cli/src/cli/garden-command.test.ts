import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  errored,
  h,
  installCliCommandsHarness,
  logged,
  logSpy,
  ops,
  paths,
  runMain,
} from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('garden --report (#2083)', () => {
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
    const parkLine = (issue: string, ts: string) =>
      JSON.stringify({
        ts,
        type: 'fail',
        issue,
        msg: 'parked',
        checkFailure: { signature: 'tests|boom', failingChecks: ['tests'] },
      });

    it('prints one cluster with count and path:line pointers, deterministically', async () => {
      writeFileSync(
        paths().events,
        `${[parkLine('1', hoursAgo(3)), parkLine('2', hoursAgo(2)), parkLine('1', hoursAgo(1))].join('\n')}\n`,
      );
      await runMain('garden', '--report');
      const first = logged();
      expect(first).toContain('## CHECK failure signatures');
      expect(first).toContain('## Park reasons');
      expect(first).toContain('## Failing checkers');
      expect(first).toContain('### 1. `fail`');
      expect(first).toContain('### 1. `tests`');
      expect(first).not.toContain('### 2.');
      expect(first).toContain('count: 3');
      for (const n of [1, 2, 3]) expect(first).toContain(`${paths().events}:${n}`);
      logSpy.mockClear();
      await runMain('garden', '--report');
      expect(logged()).toEqual(first);
    });

    it('excludes events of an environment-released run', async () => {
      const line = (type: string, issue: string) => JSON.stringify({ ts: hoursAgo(5), type, issue, msg: 'm' });
      writeFileSync(
        paths().events,
        `${[line('human-edited', '9'), line('environment-released', '9'), parkLine('1', hoursAgo(4))].join('\n')}\n`,
      );
      await runMain('garden', '--report');
      expect(logged()).not.toContain('human-edited');
      expect(logged()).not.toContain('## Human events');
    });

    it('prints no clusters for a missing events file and does not exit', async () => {
      const res = await runMain('garden', '--report');
      expect(res.exited).toBe(false);
      expect(logged()).toContain('no clusters');
    });

    const sigLine = (issue: string, sig: string, ts: string) =>
      JSON.stringify({
        ts,
        type: 'fail',
        issue,
        msg: 'parked',
        checkFailure: { signature: sig, failingChecks: ['tests'] },
      });

    it('--since and --max-clusters scope the report', async () => {
      writeFileSync(
        paths().events,
        `${[
          sigLine('1', 'sig-a', hoursAgo(24)),
          sigLine('2', 'sig-b', hoursAgo(25)),
          sigLine('3', 'sig-c', hoursAgo(26)),
          sigLine('4', 'sig-old', hoursAgo(24 * 30)),
        ].join('\n')}\n`,
      );
      await runMain('garden', '--report', '--since', '7d', '--max-clusters', '2');
      expect(logged()).not.toContain('sig-old');
      expect((logged().match(/^### /gm) ?? []).length).toBeLessThanOrEqual(2);
    });

    it('--json prints the cluster data as JSON', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      await runMain('garden', '--report', '--json');
      const doc = JSON.parse(logged());
      expect(doc.since).toBe('14d');
      expect(doc.maxClusters).toBe(10);
      expect(doc.clusters[0]).toMatchObject({ dimension: expect.any(String), key: expect.any(String), count: 1 });
      for (const k of ['issues', 'samples', 'failingChecks', 'firstSeen', 'lastSeen'])
        expect(doc.clusters[0]).toHaveProperty(k);
    });

    it('--out writes the report to a file and nothing to stdout', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      const out = join(h.repoRoot, 'report.md');
      await runMain('garden', '--report', '--out', out);
      expect(readFileSync(out, 'utf8')).toContain('# Garden report');
      expect(logSpy).not.toHaveBeenCalled();
      expect(errored()).toContain(`wrote report to ${out}`);
    });

    it('--out with --json writes valid JSON', async () => {
      writeFileSync(paths().events, `${parkLine('1', hoursAgo(1))}\n`);
      const out = join(h.repoRoot, 'report.json');
      await runMain('garden', '--report', '--json', '--out', out);
      expect(JSON.parse(readFileSync(out, 'utf8')).clusters.length).toBeGreaterThan(0);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('rejects an invalid --since or --max-clusters', async () => {
      const a = await runMain('garden', '--report', '--since', 'bogus');
      expect(a.exited).toBe(true);
      expect(a.code).not.toBe(0);
      const b = await runMain('garden', '--report', '--max-clusters', '0');
      expect(b.exited).toBe(true);
      expect(b.code).not.toBe(0);
    });

    it('exits non-zero when --out cannot be written', async () => {
      const out = join(h.repoRoot, 'missing-dir', 'r.md');
      const res = await runMain('garden', '--report', '--out', out);
      expect(res.exited).toBe(true);
      expect(errored()).toContain(`factory garden: cannot write ${out}`);
    });

    describe('read-only and empty input (#2088)', () => {
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      const emptyDoc = { since: '14d', maxClusters: 10, clusters: [] };

      const guardSideEffects = (opts: { searchAllowed: boolean }) => {
        const octokitFactory = vi.fn(() => h.octokit);
        ops.octokit = octokitFactory;
        const fetchFn = vi.fn(async () => {
          throw new Error('network');
        });
        vi.stubGlobal('fetch', fetchFn);
        return () => {
          expect(fetchFn).not.toHaveBeenCalled();
          const cmds = [...ops.exec.mock.calls, ...ops.execSync.mock.calls].map((c) => String(c[0]));
          const ghCmds = cmds.filter((c) => /(^|\s)gh\s/.test(c));
          if (opts.searchAllowed) {
            expect(h.octokit.rest.search.issuesAndPullRequests).toHaveBeenCalled();
            for (const c of ghCmds) expect(c).toMatch(/gh (repo view|auth token)/);
          } else {
            expect(octokitFactory).not.toHaveBeenCalled();
            expect(ghCmds).toEqual([]);
          }
          for (const fn of Object.values(h.octokit.rest.issues)) expect(fn).not.toHaveBeenCalled();
        };
      };

      it('only reads: searches GitHub but creates no issue, label or comment', async () => {
        writeFileSync(paths().events, `${[parkLine('1', hoursAgo(2)), parkLine('2', hoursAgo(1))].join('\n')}\n`);
        const argvs = [
          ['garden', '--report'],
          ['garden', '--report', '--json'],
          ['garden', '--report', '--out', join(h.repoRoot, 'r.md')],
        ];
        for (const argv of argvs) {
          const check = guardSideEffects({ searchAllowed: true });
          const res = await runMain(...argv);
          expect(res.exited).toBe(false);
          check();
        }
      });

      it('empty input makes no network call, creates no octokit and runs no gh', async () => {
        writeFileSync(paths().events, '');
        const check = guardSideEffects({ searchAllowed: false });
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        check();
      });

      it('an empty events file prints no clusters and exits 0', async () => {
        writeFileSync(paths().events, '');
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(res.code).toBeUndefined();
        expect(logged()).toContain('no clusters');
      });

      it('only out-of-window events print no clusters and exit 0', async () => {
        writeFileSync(paths().events, `${parkLine('1', hoursAgo(24 * 30))}\n`);
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('no clusters');
      });

      it('--json with empty input prints an empty clusters document and exits 0', async () => {
        const res = await runMain('garden', '--report', '--json');
        expect(res.exited).toBe(false);
        expect(JSON.parse(logged())).toEqual(emptyDoc);
      });

      it('--out with empty input writes no clusters and exits 0', async () => {
        const out = join(h.repoRoot, 'empty.md');
        const res = await runMain('garden', '--report', '--out', out);
        expect(res.exited).toBe(false);
        expect(readFileSync(out, 'utf8')).toBe('no clusters\n');
        expect(logSpy).not.toHaveBeenCalled();
        expect(errored()).toContain('wrote report to');
      });

      it('--json --out with empty input writes the empty JSON document', async () => {
        const out = join(h.repoRoot, 'empty.json');
        const res = await runMain('garden', '--report', '--json', '--out', out);
        expect(res.exited).toBe(false);
        expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(emptyDoc);
      });
    });

    describe('tracked/new annotation (#2102)', () => {
      const writeEvents = () => writeFileSync(paths().events, `${parkLine('1', hoursAgo(2))}\n`);

      it('annotates a cluster as tracked when an open issue carries a garden marker', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockImplementation((async () => ({
          data: { items: [{ number: 31, state: 'open', body: '<!-- garden:tests|boom -->' }] },
        })) as any);
        await runMain('garden', '--report');
        expect(logged()).toContain('- tracked: #31');
      });

      it('annotates a cluster as new when nothing matches', async () => {
        writeEvents();
        await runMain('garden', '--report');
        expect(logged()).toContain('- new');
      });

      it('--json clusters carry tracking', async () => {
        writeEvents();
        await runMain('garden', '--report', '--json');
        const doc = JSON.parse(logged());
        expect(doc.clusters.length).toBeGreaterThan(0);
        for (const c of doc.clusters) expect(c.tracking).toEqual({ status: 'new' });
      });

      it('renders tracked: unknown and exits 0 when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('### 1.');
        expect(logged()).toContain('- tracked: unknown');
        expect(logged()).not.toContain('- new');
        expect(errored()).toContain('issue search unavailable');
      });

      it('--json marks every cluster unknown when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report', '--json');
        expect(res.exited).toBe(false);
        const doc = JSON.parse(logged());
        expect(doc.clusters.length).toBeGreaterThan(0);
        for (const c of doc.clusters) expect(c.tracking).toEqual({ status: 'unknown' });
      });

      it('marks every cluster unknown and exits 0 when the repo cannot be resolved (no network)', async () => {
        writeEvents();
        const execImpl = h.execImpl;
        h.execImpl = (cmd: string) => {
          if (cmd.startsWith('gh repo view'))
            throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
          return execImpl(cmd);
        };
        const res = await runMain('garden', '--report');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('### 1.');
        expect(logged()).toContain('- tracked: unknown');
        expect(errored()).toContain('issue search unavailable');
      });
    });

    describe('--only-new (#2104)', () => {
      const writeEvents = () => writeFileSync(paths().events, `${parkLine('1', hoursAgo(2))}\n`);
      const mockTracked = () =>
        h.octokit.rest.search.issuesAndPullRequests.mockImplementation((async () => ({
          data: {
            items: [
              {
                number: 31,
                state: 'open',
                body: '<!-- garden:fail --> <!-- garden:tests --> <!-- garden:tests|boom -->',
              },
            ],
          },
        })) as any);

      it('omits clusters tracked by an open issue', async () => {
        writeEvents();
        mockTracked();
        const res = await runMain('garden', '--report', '--only-new');
        expect(res.exited).toBe(false);
        expect(logged()).not.toContain('- tracked: #31');
        expect(logged()).not.toContain('### 1.');
        expect(logged()).toContain('no clusters');
      });

      it('keeps new clusters', async () => {
        writeEvents();
        await runMain('garden', '--report', '--only-new');
        expect(logged()).toContain('- new');
        expect(logged()).toContain('### 1.');
      });

      it('--json --only-new yields no clusters when all are tracked', async () => {
        writeEvents();
        mockTracked();
        await runMain('garden', '--report', '--json', '--only-new');
        expect(JSON.parse(logged()).clusters).toEqual([]);
      });

      it('keeps tracked: unknown clusters when the search fails', async () => {
        writeEvents();
        h.octokit.rest.search.issuesAndPullRequests.mockRejectedValue(new Error('rate limited'));
        const res = await runMain('garden', '--report', '--only-new');
        expect(res.exited).toBe(false);
        expect(logged()).toContain('- tracked: unknown');
      });
    });

    it('exits non-zero without --report', async () => {
      const res = await runMain('garden');
      expect(res.exited).toBe(true);
      expect(res.code).not.toBe(0);
    });
  });
});
