import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { errored, h, installCliCommandsHarness, logged, paths, runMain } from './test-support/cli-commands-harness.js';

installCliCommandsHarness();

describe('cli commands (via main dispatch)', () => {
  describe('kpis', () => {
    it('renders a report and trend, and records a snapshot on each run', async () => {
      writeFileSync(
        paths().events,
        [
          JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }),
          JSON.stringify({ type: 'merged', issue: '1', msg: 'merged' }),
          JSON.stringify({ type: 'issue-title', issue: '2', msg: 'title' }),
          JSON.stringify({ type: 'rework', issue: '2', msg: 'rework' }),
          '',
        ].join('\n'),
      );
      writeFileSync(paths().costs, '');
      h.costs = [{ issue: '1', task: 'build', model: 'a', cost: 0.5 }];
      h.execImpl = (cmd: string) => {
        if (cmd.includes('rev-parse HEAD')) return 'deadbeef';
        if (cmd.includes('rev-parse')) return h.repoRoot;
        if (cmd.includes('gh repo view')) return h.ghRepo;
        return '';
      };
      const bad = await runMain('kpis', '--branch-prefix', '!!!');
      expect(bad).toEqual({ exited: true, code: 2 });
      expect(errored()).toContain('--branch-prefix');

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(out).toContain('## Health KPI trend');
      expect(existsSync(paths().kpiHistory)).toBe(true);
      const historyLines = (jsonl: string) => jsonl.trim().split('\n').filter(Boolean);
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(1);
      const firstRecord = JSON.parse(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))[0]);
      expect(firstRecord.commitSha).toBe('deadbeef');
      expect(firstRecord.models).toEqual({});
      expect(firstRecord).not.toHaveProperty('partial');

      await runMain('kpis');
      expect(historyLines(readFileSync(paths().kpiHistory, 'utf-8'))).toHaveLength(2);
    });

    it('a GitHub failure during reconstruction marks the snapshot partial and warns (#2342)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      h.octokit.rest.pulls.list = vi.fn(async () => {
        throw new Error('rate limited');
      });

      await runMain('kpis');
      expect(errored()).toContain('human-event reconstruction failed');
      expect(errored()).toContain('rate limited');
      expect(errored()).toContain('marked partial');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.partial).toBe(true);
    });

    it('still renders the report when the KPI snapshot fails (e.g. a malformed repo tier config)', async () => {
      writeFileSync(paths().config, JSON.stringify({ tiers: { worker: ['no-such-model'] } }));
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));

      const res = await runMain('kpis');
      expect(res.exited).toBe(false);
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(out).toContain('## Health KPI trend');
      expect(errored()).toContain('KPI snapshot failed');
      expect(existsSync(paths().kpiHistory)).toBe(false);
    });

    it('records postMergeDefectRate when a merged PR has a closed window and a matching revert commit (#612)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const revertAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
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
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => ({
          data: [{ sha: 'deadbeef1234', commit: { message: 'Revert "fix thing" (#77)', author: { date: revertAt } } }],
        })),
      };
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listComments = vi.fn(async () => ({ data: [] }));

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('Post-merge defects:');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.defectWindowClosedRuns).toBe(1);
      expect(record.postMergeDefectRate).toBe(1);
    });

    it('upserts classifier outcomes once per PR across repeated kpis runs (#1726)', async () => {
      const mergedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(
        paths().events,
        JSON.stringify({
          type: 'pr-classified',
          issue: '1',
          ts: mergedAt,
          prClassification: {
            modelClass: 'A',
            floorClass: 'B',
            finalClass: 'B',
            model: 'm',
            promptVersion: 'p1',
            policyVersion: 'f1',
            diffSha: 'abc',
            adrIds: [],
            costUsd: null,
            claims: [],
            unsupportedClaims: [],
            notInspected: [],
            droppedClaims: 0,
          },
        }),
      );
      writeFileSync(paths().costs, '');
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
      h.octokit.rest.issues.listForRepo = vi.fn(async () => ({ data: [] }));
      h.octokit.rest.issues.listComments = vi.fn(async () => ({ data: [] }));

      await runMain('kpis');
      await runMain('kpis');
      const lines = readFileSync(paths().classifierOutcomes, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ prNumber: 77, modelClass: 'A', verdict: 'agree' });
    });

    it('does not write classifier outcomes when post-merge defect detection fails (#1726)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
      h.octokit.rest.pulls.list = vi.fn(async ({ state }: any) =>
        state === 'all'
          ? {
              data: [
                {
                  number: 77,
                  head: { ref: 'factory/1-fix-the-bug' },
                  state: 'closed',
                  merged_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
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
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => {
          throw new Error('rate limited');
        }),
      };
      await runMain('kpis');
      expect(existsSync(paths().classifierOutcomes)).toBe(false);
    });

    it('omits postMergeDefectRate and warns when the post-merge defect fetch fails (#612)', async () => {
      writeFileSync(paths().events, JSON.stringify({ type: 'issue-title', issue: '1', msg: 'title' }));
      writeFileSync(paths().costs, '');
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
      h.octokit.rest.repos = {
        listCommits: vi.fn(async () => {
          throw new Error('rate limited');
        }),
      };

      await runMain('kpis');
      const out = logged();
      expect(out).toContain('## Health KPIs');
      expect(errored()).toContain('post-merge defect signals unavailable');
      const record = JSON.parse(readFileSync(paths().kpiHistory, 'utf-8').trim().split('\n')[0]);
      expect(record.postMergeDefectRate).toBeNull();
    });
  });
});
