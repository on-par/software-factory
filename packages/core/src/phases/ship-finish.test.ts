import { describe, expect, it, vi } from 'vitest';

import type { VisualProofResult } from '../checkers/visual-proof.js';
import { finishShip } from './ship-finish.js';
import type { ShipPhaseOptions } from './ship-options.js';

const HEAD = 'a'.repeat(40);

function setup(gate?: ShipPhaseOptions['visualProofGate'], extra: Partial<ShipPhaseOptions> = {}) {
  const graphql = vi.fn(async () => ({}));
  const octokit: any = {
    graphql,
    rest: { pulls: { get: vi.fn(async () => ({ data: { draft: true, node_id: 'PR_1' } })) } },
  };
  const log = vi.fn();
  const opts = {
    octokit,
    worktree: '/tmp/wt',
    log,
    ...(gate ? { visualProofGate: gate } : {}),
    ...extra,
  } as ShipPhaseOptions;
  const run: any = vi.fn(async () => ({ stdout: `${HEAD}\n` }));
  const finish = (ctx: Partial<Parameters<typeof finishShip>[0]> = {}) =>
    finishShip({ opts, run, owner: 'o', repoName: 'r', prNumber: 5, headSha: HEAD, ...ctx });
  return { finish, graphql, log };
}

const proof = (patch: Partial<VisualProofResult>): VisualProofResult => ({
  status: 'pass',
  headSha: HEAD,
  runId: 'run',
  captures: [],
  ...patch,
});

describe('finishShip visual proof gate (#2232)', () => {
  it('does not mark the PR ready when visual proof fails and names the diagnostic', async () => {
    const { finish, graphql } = setup(async () => proof({ status: 'fail', diagnostic: 'blank or empty image' }));
    const r = await finish();
    expect(r).toMatchObject({ ok: false, prNumber: 5, headSha: HEAD, visualProof: { status: 'fail' } });
    expect(r.reason).toContain('blank or empty image');
    expect(graphql).not.toHaveBeenCalled();
  });

  it('keeps the PR a draft when CI is pending', async () => {
    const gate = vi.fn(async () => proof({}));
    const r = await setup(gate).finish({ ciOutcome: 'timeout' });
    expect(gate).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, draft: true, ciPending: true, ciOutcome: 'timeout' });
  });

  it('includes visualProof in the ok result on pass and marks ready', async () => {
    const { finish, graphql } = setup(async () => proof({}));
    expect(await finish()).toMatchObject({ ok: true, visualProof: { status: 'pass' } });
    expect(graphql).toHaveBeenCalledTimes(1);
  });

  it('passes through a not-required result', async () => {
    const { finish } = setup(async () => proof({ status: 'not-required' }));
    expect(await finish()).toMatchObject({ ok: true, visualProof: { status: 'not-required' } });
  });

  it('resolves the head from git when none was supplied', async () => {
    const gate = vi.fn(async () => proof({ status: 'not-required' }));
    await setup(gate).finish({ headSha: undefined });
    expect(gate).toHaveBeenCalledWith({ prNumber: 5, headSha: HEAD });
  });

  it('behaves as before with no gate', async () => {
    const { finish, graphql } = setup();
    const r = await finish();
    expect(r).toEqual({ ok: true, prNumber: 5, headSha: HEAD });
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
