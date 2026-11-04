// packages/cli/src/cli/run-brief.test.ts — run-brief rejects a bad --base-branch before resolving any brief (#3764)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CliExitError } from './errors.js';
import { cmdRunBrief, type RunBriefRuntime } from './run-brief.js';
import type { MergeResult } from './run-issue-merge.js';
import { errored, h, installShipHarness, phases, runMainWith, shipIssue } from './test-support/ship-harness.js';

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
  const runtime = (driveToMerge: RunBriefRuntime['driveToMerge']): RunBriefRuntime => ({
    isCommandAvailable: () => true,
    getRepoRoot: async () => h.repoRoot,
    getGitHubRepo: async () => h.ghRepo,
    getOctokit: () => h.octokit as any,
    branchPrefixOrExit: () => 'ship-it',
    errorDetail: (err) => String(err),
    driveToMerge,
    shipIssue,
  });
  const second = () => {
    const path = join(h.repoRoot, 'beta.md');
    writeFileSync(path, '# Add beta\n\nPlease add beta.\n\n## Acceptance criteria\n\n- beta exists\n');
    return path;
  };

  it.each([
    [{ admin: true }, '--merge-timeout/--admin need --merge'],
    [{ mergeTimeout: '5m' }, '--merge-timeout/--admin need --merge'],
    [{ merge: true, pr: false }, '--merge needs a PR'],
    [{ merge: true, workspace: '/tmp/x' }, 'never merge'],
    [{ merge: true, stack: true }, '--merge lands one PR per brief'],
    [{ merge: true, mergeTimeout: 'x' }, '--merge-timeout must be a positive duration'],
  ])('%j exits 2', async (opts, message) => {
    const drive = vi.fn();
    const err = await cmdRunBrief([brief()], opts, runtime(drive)).catch((e) => e);
    expect(err).toBeInstanceOf(CliExitError);
    expect(err.code).toBe(2);
    expect(err.message).toContain(message);
    expect(drive).not.toHaveBeenCalled();
  });

  it('drives one brief through driveToMerge issueless with the brief run number', async () => {
    const drive = vi.fn(async (): Promise<MergeResult> => ({ kind: 'merged', prNumber: 5, detail: 'merged' }));
    await cmdRunBrief([brief()], { merge: true, mergeTimeout: '10m', admin: true }, runtime(drive));
    expect(drive).toHaveBeenCalledTimes(1);
    const input = (drive.mock.calls[0] as any[])[0];
    expect(input).toMatchObject({ issueless: true, admin: true, timeoutMs: 600_000, ghRepo: h.ghRepo });
    expect(input.issue).toBeGreaterThanOrEqual(9_000_000);
  });

  it('a single held brief exits with the held code', async () => {
    const drive = vi.fn(async (): Promise<MergeResult> => ({ kind: 'held', gate: 'risk', detail: 'held' }));
    const err = await cmdRunBrief([brief()], { merge: true }, runtime(drive)).catch((e) => e);
    expect(err).toMatchObject({ code: 10 });
    expect(err.message).toContain('held by risk');
  });

  it('several briefs: each is driven, a failure does not stop the rest, exit is the first failed code', async () => {
    const results: MergeResult[] = [
      { kind: 'ci-failed', detail: 'red' },
      { kind: 'held', gate: 'risk', detail: 'held' },
    ];
    const drive = vi.fn(async () => results.shift() as MergeResult);
    const err = await cmdRunBrief([brief(), second()], { merge: true, mergeTimeout: '1m' }, runtime(drive)).catch(
      (e) => e,
    );
    expect(drive).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ code: 11 });
  });

  it('several briefs without --merge still exit 1 and never drive a merge', async () => {
    const drive = vi.fn();
    phases.shipPhase.mockRejectedValueOnce(new Error('boom'));
    const err = await cmdRunBrief([brief(), second()], {}, runtime(drive)).catch((e) => e);
    expect(err).toMatchObject({ code: 1 });
    expect(drive).not.toHaveBeenCalled();
  });
});
