import type { Octokit } from '@octokit/rest';
import { describe, expect, it, vi } from 'vitest';

import { FACTORY_TASK_REQUIRED_FIELDS, scoreIssueReadiness } from '../readiness/index.js';
import { BlockerFilingError, blockerMarker, fileBlocker, hashBlockerClaim, renderBlockerBody } from './file-blocker.js';
import type { BlockerClaim, BlockerRefusalReason } from './file-blocker.js';

const NOW = () => new Date('2026-10-14T12:00:00Z');
const PARENT = 100;
const SUB_ROUTE = 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues';
const BLOCKED_BY = 'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by';
const LINK = 'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues';

const CLAIM: BlockerClaim = {
  title: 'Add retry primitive',
  problem: 'Callers need a retry primitive before the importer can be hardened.',
  inScope: ['Implement retry with backoff'],
  acceptance: ['Retry succeeds after transient failure'],
};

interface Setup {
  subIssues?: unknown;
  daily?: unknown;
  blockedBy?: unknown;
  parentBody?: string | null;
  parentThrows?: boolean;
  subThrows?: boolean;
  dailyThrows?: boolean;
  createThrows?: boolean;
  linkThrows?: boolean;
  blockedByPostThrows?: boolean;
  blockedByGetThrows?: boolean;
}

function makeFake(s: Setup = {}) {
  const create = vi.fn(async (params: { body: string }) => {
    if (s.createThrows) throw new Error('create boom');
    return { data: { number: 501, id: 9501, body: params.body } };
  });
  const get = vi.fn(async () => {
    if (s.parentThrows) throw new Error('get boom');
    return { data: { body: s.parentBody ?? 'parent body' } };
  });
  const request = vi.fn(async (route: string) => {
    if (route === LINK && s.linkThrows) throw new Error('link boom');
    if (route === BLOCKED_BY && s.blockedByPostThrows) throw new Error('post boom');
    if (route.startsWith('GET') && s.blockedByGetThrows) throw new Error('get blocked boom');
    if (route.startsWith('GET')) return { data: s.blockedBy ?? [] };
    return { data: {} };
  });
  const paginate = vi.fn(async (route: string) => {
    if (route === SUB_ROUTE) {
      if (s.subThrows) throw new Error('sub boom');
      return s.subIssues ?? [];
    }
    if (s.dailyThrows) throw new Error('daily boom');
    return s.daily ?? [];
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const octokit: any = { request, paginate, rest: { issues: { get, create } } };
  return { octokit, request, paginate, create, get };
}

function run(fake: { octokit: Octokit }, overrides: Partial<{ claim: unknown; maxPerDay: number }> = {}) {
  return fileBlocker({
    octokit: fake.octokit,
    repo: 'on-par/software-factory',
    parent: PARENT,
    claim: 'claim' in overrides ? overrides.claim : CLAIM,
    policy: { maxPerDay: overrides.maxPerDay ?? 20 },
    now: NOW,
  });
}

async function expectRefusal(promise: Promise<unknown>, reason: BlockerRefusalReason) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BlockerFilingError);
  expect((error as BlockerFilingError).reason).toBe(reason);
  return error as BlockerFilingError;
}

const markerFor = (parent: number, hash = 'abcdef012345') => blockerMarker(parent, hash);
const posts = (fake: ReturnType<typeof makeFake>) =>
  fake.request.mock.calls.filter(([route]) => (route as string).startsWith('POST'));

describe('fileBlocker', () => {
  it("files one child, links it as a sub-issue and adds it to the parent's blocked_by", async () => {
    const fake = makeFake();
    const result = await run(fake);
    expect(result).toEqual({ outcome: 'filed', number: 501 });
    expect(fake.create).toHaveBeenCalledTimes(1);
    const params = fake.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('labels');
    expect(params.body).toContain(blockerMarker(PARENT, hashBlockerClaim(CLAIM)));
    expect(fake.request).toHaveBeenCalledWith(
      LINK,
      expect.objectContaining({ issue_number: PARENT, sub_issue_id: 9501 }),
    );
    expect(fake.request).toHaveBeenCalledWith(
      BLOCKED_BY,
      expect.objectContaining({ issue_number: PARENT, issue_id: 9501 }),
    );
  });

  it('defaults now to the real clock', async () => {
    const fake = makeFake();
    const result = await fileBlocker({
      octokit: fake.octokit,
      repo: 'on-par/software-factory',
      parent: PARENT,
      claim: CLAIM,
      policy: { maxPerDay: 20 },
    });
    expect(result.outcome).toBe('filed');
  });

  it('returns the existing child on a re-run with the same claim and creates nothing', async () => {
    const first = makeFake();
    await run(first);
    const body = (first.create.mock.calls[0]![0] as { body: string }).body;
    const second = makeFake({
      subIssues: [{ id: 9501, number: 501, title: 'x', body, state: 'open' }],
      blockedBy: [{ number: 501 }],
    });
    await expect(run(second)).resolves.toEqual({ outcome: 'existing', number: 501 });
    expect(second.create).not.toHaveBeenCalled();
    expect(posts(second)).toHaveLength(0);
  });

  it('heals a missing blocked_by link on the existing path', async () => {
    const first = makeFake();
    await run(first);
    const body = (first.create.mock.calls[0]![0] as { body: string }).body;
    const second = makeFake({ subIssues: [{ id: 9501, number: 501, title: 'x', body, state: 'closed' }] });
    await expect(run(second)).resolves.toEqual({ outcome: 'existing', number: 501 });
    expect(second.create).not.toHaveBeenCalled();
    expect(posts(second)).toHaveLength(1);
    expect(second.request).toHaveBeenCalledWith(BLOCKED_BY, expect.objectContaining({ issue_id: 9501 }));
  });

  it('refuses with max-blockers-reached', async () => {
    const fake = makeFake({
      subIssues: [
        { id: 1, number: 11, title: 'a', body: markerFor(PARENT, 'aaaaaaaaaaaa'), state: 'open' },
        { id: 2, number: 12, title: 'b', body: markerFor(PARENT, 'bbbbbbbbbbbb'), state: 'closed' },
        { id: 3, number: 13, title: 'c', body: markerFor(PARENT, 'cccccccccccc') },
      ],
    });
    await expectRefusal(run(fake), 'max-blockers-reached');
    expect(fake.create).not.toHaveBeenCalled();
    expect(posts(fake)).toHaveLength(0);
  });

  it('refuses with parent-is-blocker', async () => {
    const fake = makeFake({ parentBody: `text\n${markerFor(7)}` });
    await expectRefusal(run(fake), 'parent-is-blocker');
    expect(fake.create).not.toHaveBeenCalled();
    expect(posts(fake)).toHaveLength(0);
  });

  it('returns a similar open sub-issue as a duplicate and files nothing', async () => {
    const text = renderBlockerBody(CLAIM, PARENT, 'ffffffffffff');
    const fake = makeFake({ subIssues: [{ id: 5, number: 55, title: CLAIM.title, body: text, state: 'open' }] });
    const result = await run(fake);
    expect(result).toMatchObject({ outcome: 'duplicate', number: 55 });
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('does not treat a closed similar sub-issue as a duplicate', async () => {
    const text = renderBlockerBody(CLAIM, PARENT, 'ffffffffffff');
    const fake = makeFake({ subIssues: [{ id: 5, number: 55, title: CLAIM.title, body: text, state: 'closed' }] });
    await expect(run(fake)).resolves.toEqual({ outcome: 'filed', number: 501 });
  });

  it("refuses with daily-cap-reached, counting only today's marker-bearing issues", async () => {
    const todayMarked = (n: number) => ({ number: n, created_at: '2026-10-14T01:00:00Z', body: markerFor(n) });
    const fake = makeFake({
      daily: [
        todayMarked(1),
        todayMarked(2),
        { number: 3, created_at: '2026-10-13T23:00:00Z', body: markerFor(3) },
        { ...todayMarked(4), pull_request: {} },
        { number: 5, created_at: '2026-10-14T02:00:00Z', body: 'no marker' },
        { number: 6, created_at: '2026-10-14T02:00:00Z', body: null },
      ],
    });
    await expectRefusal(run(fake, { maxPerDay: 2 }), 'daily-cap-reached');
    expect(fake.create).not.toHaveBeenCalled();
    const passing = makeFake({ daily: [todayMarked(1)] });
    await expect(run(passing, { maxPerDay: 2 })).resolves.toMatchObject({ outcome: 'filed' });
  });

  it.each([
    ['parent GET throws', { parentThrows: true }],
    ['sub-issue paginate throws', { subThrows: true }],
    ['sub-issue paginate returns a non-array', { subIssues: { nope: true } }],
    ['daily paginate throws', { dailyThrows: true }],
    ['daily paginate returns a non-array', { daily: 'nope' }],
  ] as [string, Setup][])('fails closed when %s', async (_name, setup) => {
    const fake = makeFake(setup);
    await expectRefusal(run(fake), 'listing-unverified');
    expect(fake.create).not.toHaveBeenCalled();
  });

  it('maps a create failure to create-failed', async () => {
    await expectRefusal(run(makeFake({ createThrows: true })), 'create-failed');
  });

  it.each([
    ['sub-issue link', { linkThrows: true }],
    ['blocked_by POST', { blockedByPostThrows: true }],
  ] as [string, Setup][])('maps a %s failure to link-failed with childNumber', async (_name, setup) => {
    const error = await expectRefusal(run(makeFake(setup)), 'link-failed');
    expect(error.childNumber).toBe(501);
  });

  it('maps a blocked_by GET failure on the existing path to link-failed', async () => {
    const first = makeFake();
    await run(first);
    const body = (first.create.mock.calls[0]![0] as { body: string }).body;
    const fake = makeFake({
      subIssues: [{ id: 9501, number: 501, title: 'x', body, state: 'open' }],
      blockedByGetThrows: true,
    });
    const error = await expectRefusal(run(fake), 'link-failed');
    expect(error.childNumber).toBe(501);
  });

  it.each([
    ['empty title', { ...CLAIM, title: '  ' }],
    ['empty inScope', { ...CLAIM, inScope: [] }],
    ['non-object', 'nope'],
  ])('rejects an invalid claim (%s)', async (_name, claim) => {
    const fake = makeFake();
    const error = await expectRefusal(run(fake, { claim }), 'invalid-claim');
    expect(error.name).toBe('BlockerFilingError');
    expect(error.childNumber).toBeUndefined();
    expect(fake.get).not.toHaveBeenCalled();
  });
});

describe('blocker helpers', () => {
  it('hashes stably across trimmed equivalents and changes with the claim', () => {
    const padded = { ...CLAIM, title: ` ${CLAIM.title} `, inScope: [` ${CLAIM.inScope[0]} `] };
    expect(hashBlockerClaim(padded)).toBe(hashBlockerClaim(CLAIM));
    expect(hashBlockerClaim(CLAIM)).toMatch(/^[0-9a-f]{12}$/);
    expect(hashBlockerClaim({ ...CLAIM, problem: 'different' })).not.toBe(hashBlockerClaim(CLAIM));
  });

  it('formats the marker exactly', () => {
    expect(blockerMarker(12, 'abc')).toBe('<!-- factory-blocker v1 parent:12 hash:abc -->');
  });

  it('renders a ready factory-task body ending with the marker', () => {
    const hash = hashBlockerClaim(CLAIM);
    const body = renderBlockerBody(CLAIM, PARENT, hash);
    expect(body.split('\n').at(-1)).toBe(blockerMarker(PARENT, hash));
    expect(body).not.toContain('## Children');
    const readiness = scoreIssueReadiness({ title: CLAIM.title, body });
    expect(readiness.template).toBe('factory-task');
    expect(readiness.pass).toBe(true);
    for (const field of FACTORY_TASK_REQUIRED_FIELDS) {
      expect(readiness.missing).not.toContain(field);
    }
  });
});
