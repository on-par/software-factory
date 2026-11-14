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

  it('leaves a ci-pending draft when CI is pending and proof is not required (#4047)', async () => {
    const gate = vi.fn(async () => proof({ status: 'not-required' }));
    const { finish, graphql } = setup(gate);
    const r = await finish({ ciOutcome: 'timeout' });
    expect(gate).toHaveBeenCalledWith({ prNumber: 5, headSha: HEAD });
    expect(r).toMatchObject({
      ok: true,
      draft: true,
      ciPending: true,
      draftReason: 'ci-pending',
      ciOutcome: 'timeout',
      visualProof: { status: 'not-required' },
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('captures proof while CI is pending and leaves a ci-pending draft with it (#4047)', async () => {
    const gate = vi.fn(async () => proof({}));
    const { finish, graphql } = setup(gate);
    const r = await finish({ ciOutcome: 'timeout' });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      ok: true,
      draft: true,
      ciPending: true,
      draftReason: 'ci-pending',
      visualProof: { status: 'pass', headSha: HEAD },
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('fails SHIP with unavailable proof when the gate throws while CI is pending (#4047)', async () => {
    const r = await setup(async () => {
      throw new Error('start exited');
    }).finish({ ciOutcome: 'timeout' });
    expect(r).toMatchObject({
      ok: false,
      draft: true,
      ciPending: true,
      visualProof: { status: 'unavailable', diagnostic: 'start exited' },
    });
    expect(r.reason).toContain('start exited');
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

  it('advisory mode: a non-pass result warns, marks ready and carries visualProof (#4047)', async () => {
    const gate = async () => proof({ status: 'fail', diagnostic: 'blank or empty image' });
    const { finish, graphql, log } = setup(gate, { visualProofMode: 'advisory' });
    const r = await finish();
    expect(r).toMatchObject({
      ok: true,
      prNumber: 5,
      visualProof: { status: 'fail', diagnostic: 'blank or empty image' },
    });
    expect(graphql).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      `visual proof fail for PR #5 at ${HEAD.slice(0, 12)}: blank or empty image (advisory: not blocking SHIP)`,
    );
  });

  it('advisory mode: unavailable proof while CI is pending leaves a ci-pending draft (#4047)', async () => {
    const { finish, graphql } = setup(
      async () => {
        throw new Error('no port');
      },
      { visualProofMode: 'advisory' },
    );
    const r = await finish({ ciOutcome: 'timeout' });
    expect(r).toMatchObject({
      ok: true,
      draft: true,
      draftReason: 'ci-pending',
      visualProof: { status: 'unavailable', diagnostic: 'no port' },
    });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('required mode (explicit): a non-pass result still fails SHIP (#4047)', async () => {
    const { finish, graphql } = setup(async () => proof({ status: 'unavailable', diagnostic: 'x' }), {
      visualProofMode: 'required',
    });
    expect(await finish()).toMatchObject({ ok: false, visualProof: { status: 'unavailable' } });
    expect(graphql).not.toHaveBeenCalled();
  });

  it('behaves as before with no gate', async () => {
    const { finish, graphql } = setup();
    const r = await finish();
    expect(r).toEqual({ ok: true, prNumber: 5, headSha: HEAD });
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
