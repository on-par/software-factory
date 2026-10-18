// packages/cli/src/cli/ship-run-state.test.ts — shipIssue persists IssueRunState as the run progresses (#3194)
import { readIssueRunState, runStateFile } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { LaneParkError } from './index.js';
import { buildRunDiffstatJson } from './runs-diffstat.js';
import { buildRunsJson } from './runs.js';
import { h, installShipHarness, paths, phases, shipIssue } from './test-support/ship-harness.js';

installShipHarness();

describe('shipIssue run state (#3194)', () => {
  const ctx = () => ({ repoRoot: h.repoRoot, ghRepo: h.ghRepo, lane: 'bugfix' });

  it('writes issue-42.json with status building, branch and lane when the build phase starts', async () => {
    h.shipResult = { ok: true, prNumber: 7 };
    let seen: Awaited<ReturnType<typeof readIssueRunState>> = null;
    phases.buildPhase.mockImplementation(async () => {
      seen = await readIssueRunState(runStateFile(paths().runs, 42));
      return h.buildResult;
    });

    const branch = await shipIssue(42, {}, ctx());

    expect(seen).toMatchObject({ issue: 42, status: 'building', lane: 'bugfix', branch });
    expect(branch).not.toBe('');
  });

  it('a ready run shows status/branch/lane/prNumber in buildRunsJson and buildRunDiffstatJson resolves', async () => {
    h.shipResult = { ok: true, prNumber: 7 };
    const branch = await shipIssue(42, {}, ctx());

    const { json } = await buildRunsJson(paths().runs);
    const row = json.runs.find((r) => r.issue === 42);
    expect(row).toMatchObject({ status: 'ready', branch, lane: 'bugfix', prNumber: 7 });
    expect(row?.startedAt).not.toBeNull();

    await expect(
      buildRunDiffstatJson({
        runsDir: paths().runs,
        repoRoot: h.repoRoot,
        issue: 42,
        git: async () => {
          throw new Error('no git');
        },
        resolveBase: async () => 'origin/main',
      }),
    ).resolves.toMatchObject({ issue: 42, reason: 'base-missing' });
  });

  it('a run parked in CHECK shows status parked and keeps its first-write startedAt', async () => {
    let firstStartedAt: string | undefined;
    phases.buildPhase.mockImplementation(async () => {
      firstStartedAt = (await readIssueRunState(runStateFile(paths().runs, 42)))?.startedAt;
      return h.buildResult;
    });
    h.checkResult = {
      passed: false,
      summary: { results: [{ checker: 'tests', result: 'FAIL', details: 'x' }], failures: 1 },
      reworkRounds: 0,
      failureSignature: 'sig-1',
    };

    await expect(shipIssue(42, {}, ctx())).rejects.toBeInstanceOf(LaneParkError);

    const { json } = await buildRunsJson(paths().runs);
    const row = json.runs.find((r) => r.issue === 42);
    expect(firstStartedAt).toBeDefined();
    expect(row).toMatchObject({ status: 'parked', startedAt: firstStartedAt });
  });
});
