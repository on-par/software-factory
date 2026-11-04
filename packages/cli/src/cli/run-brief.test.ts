// packages/cli/src/cli/run-brief.test.ts — run-brief rejects a bad --base-branch before resolving any brief (#3764)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { cmdRunBrief, type RunBriefOptions, type RunBriefRuntime } from './run-brief.js';
import type { MergeResult } from './run-issue-merge.js';
import { errored, h, installShipHarness, phases, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

function brief(): string {
  const path = join(h.repoRoot, 'alpha.md');
  writeFileSync(path, '# Add alpha\n\nPlease add alpha.\n\n## Acceptance criteria\n\n- alpha exists\n');
  return path;
}

describe('run-brief --base-branch (#3764)', () => {
  it('rejects an empty list of brief files before accessing the runtime', async () => {
    await expect(cmdRunBrief([], {}, {} as RunBriefRuntime)).rejects.toMatchObject({
      message: expect.stringContaining('needs at least one brief file'),
      code: 2,
    });
  });

  it('rejects a -prefixed --base-branch before resolving any brief', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch=-x');
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain("invalid --base-branch '-x'");
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('rejects --base-branch with --workspace', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch', 'feat/x', '--workspace', h.repoRoot);
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain('--base-branch needs a factory worktree');
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('starts the brief run from origin/<ref>', async () => {
    const res = await runMain('run-brief', brief(), '--base-branch', 'feat/x');
    expect(res.exited).toBe(false);
    expect((phases.shipPhase.mock.calls[0][0] as any).baseBranch).toBe('feat/x');
  });
});

describe('run-brief --merge (#3905)', () => {
  // A fake SHIP that reports a shipped PR, so the merge call is the only thing under test.
  const ship = async (_n: number, _o: unknown, ctx: any) => {
    ctx.onOutcome({ state: 'shipped', route: 'claude', branch: 'ship-it/9-x', reworkRounds: 0, prNumber: 99 });
  };
  const fakeRuntime = (driveToMerge: (...a: any[]) => Promise<MergeResult>): RunBriefRuntime => ({
    isCommandAvailable: () => true,
    getRepoRoot: async () => h.repoRoot,
    getGitHubRepo: async () => h.ghRepo,
    getOctokit: () => h.octokit,
    branchPrefixOrExit: () => 'factory',
    errorDetail: (err) => String(err),
    awaitingCiCapMs: () => 3_600_000,
    driveToMerge: driveToMerge as RunBriefRuntime['driveToMerge'],
    shipIssue: ship as RunBriefRuntime['shipIssue'],
  });
  const second = () => {
    const path = join(h.repoRoot, 'beta.md');
    writeFileSync(path, '# Add beta\n\nPlease add beta.\n\n## Acceptance criteria\n\n- beta exists\n');
    return path;
  };
  const code = async (opts: RunBriefOptions) =>
    cmdRunBrief(
      [brief()],
      opts,
      fakeRuntime(async () => ({ kind: 'merged', detail: '' })),
    ).then(
      () => 0,
      (e: { code: number }) => e.code,
    );

  it('rejects conflicting flags with exit 2 before running anything', async () => {
    expect(await code({ mergeTimeout: '5m' })).toBe(2);
    expect(await code({ admin: true })).toBe(2);
    expect(await code({ merge: true, pr: false })).toBe(2);
    expect(await code({ merge: true, workspace: h.repoRoot })).toBe(2);
    expect(await code({ merge: true, stack: true })).toBe(2);
    expect(await code({ merge: true, mergeTimeout: 'soon' })).toBe(2);
    expect(phases.planPhase).not.toHaveBeenCalled();
  });

  it('drives the brief run to merge as an issueless run and exits 0 when merged', async () => {
    const drive = vi.fn(async (): Promise<MergeResult> => ({ kind: 'merged', prNumber: 99, detail: 'merged' }));
    await cmdRunBrief([brief()], { merge: true, mergeTimeout: '5m', admin: true }, fakeRuntime(drive));
    expect(drive).toHaveBeenCalledTimes(1);
    const input = (drive.mock.calls as any[])[0][0];
    expect(input).toMatchObject({ issueless: true, admin: true, timeoutMs: 300_000, ghRepo: h.ghRepo });
    expect(input.issue).toBeGreaterThanOrEqual(9_000_000);
  });

  it('defaults the wait bound to the config cap', async () => {
    const drive = vi.fn(async (): Promise<MergeResult> => ({ kind: 'merged', detail: '' }));
    await cmdRunBrief([brief()], { merge: true }, fakeRuntime(drive));
    expect((drive.mock.calls as any[])[0][0].timeoutMs).toBe(3_600_000);
  });

  it('a held brief exits with the held code', async () => {
    const drive = async (): Promise<MergeResult> => ({ kind: 'held', gate: 'risk', prNumber: 5, detail: 'held' });
    await expect(cmdRunBrief([brief()], { merge: true }, fakeRuntime(drive))).rejects.toMatchObject({ code: 10 });
  });

  it('several briefs: a failure does not stop the rest and the exit is the first failed brief code', async () => {
    const results: MergeResult[] = [
      { kind: 'ci-failed', detail: 'red' },
      { kind: 'merged', detail: 'merged' },
    ];
    const drive = vi.fn(async () => results.shift()!);
    await expect(cmdRunBrief([brief(), second()], { merge: true }, fakeRuntime(drive))).rejects.toMatchObject({
      code: 11,
    });
    expect(drive).toHaveBeenCalledTimes(2);
  });

  it('several briefs without --merge still exit 1 on failure', async () => {
    const failing = async () => {
      throw new Error('plan blew up');
    };
    const rt = { ...fakeRuntime(vi.fn()), shipIssue: failing as unknown as RunBriefRuntime['shipIssue'] };
    await expect(cmdRunBrief([brief(), second()], {}, rt)).rejects.toMatchObject({ code: 1 });
  });

  it('a CI-failed park whose SHIP throws is still driven to the ci-failed result with --merge', async () => {
    const parking = async (_n: number, _o: unknown, ctx: any) => {
      ctx.onOutcome({ state: 'parked', reason: 'ci-failed', prNumber: 7 });
      throw new Error('parked');
    };
    const drive = vi.fn(async (): Promise<MergeResult> => ({ kind: 'ci-failed', prNumber: 7, detail: 'red' }));
    const rt = { ...fakeRuntime(drive), shipIssue: parking as unknown as RunBriefRuntime['shipIssue'] };
    await expect(cmdRunBrief([brief()], { merge: true }, rt)).rejects.toMatchObject({ code: 11 });
    expect(drive).toHaveBeenCalledTimes(1);
    // without --merge the same park keeps the plain failure exit
    await expect(cmdRunBrief([brief()], {}, rt)).rejects.toMatchObject({ code: 1 });
  });
});
