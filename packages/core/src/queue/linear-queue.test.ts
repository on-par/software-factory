import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LinearTrackerSchema } from '../config/tracker-section.js';
import { LinearApiError } from '../work/linear-client.js';
import { claimedByLabel } from './github-queue.js';
import {
  compareLinearCandidates,
  createLinearQueue,
  createLinearQueueGraphqlClient,
  isLinearCandidate,
  LINEAR_LEASE_ATTACHMENT_URL,
  linearLaneOf,
  type LinearQueueClient,
  type LinearQueueIssue,
} from './linear-queue.js';

const fixture: LinearQueueIssue[] = JSON.parse(
  readFileSync(new URL('./__fixtures__/linear-queue-foreman.json', import.meta.url), 'utf-8'),
);
const linear = LinearTrackerSchema.parse({ teamKey: 'ON', projects: { Foreman: 'on-par/foreman' } });

interface Entry {
  issue: LinearQueueIssue;
  labels: Set<string>;
  state: string;
}

function fakeClient(issues: LinearQueueIssue[], store?: Map<string, Entry>) {
  const map =
    store ??
    new Map(issues.map((i) => [i.id, { issue: i, labels: new Set(i.labels.map((l) => l.name)), state: 'Todo' }]));
  const calls: string[] = [];
  const names = new Map<string, string>();
  const client: LinearQueueClient & { hooks: { afterAdd?: (id: string) => void } } = {
    hooks: {},
    async listCandidates() {
      return [...map.values()].map((e) => ({
        ...e.issue,
        labels: [...e.labels].map((n) => ({
          id: n,
          name: n,
          ...(e.issue.labels.find((l) => l.name === n)?.group ? { group: 'lane' } : {}),
        })),
      }));
    },
    async issueLabels(id) {
      calls.push('issueLabels');
      return [...(map.get(id)?.labels ?? [])];
    },
    async ensureLabel(name) {
      calls.push('ensureLabel');
      names.set(name, name);
      return name;
    },
    async addLabel(id, labelId) {
      calls.push('addLabel');
      map.get(id)?.labels.add(labelId);
      client.hooks.afterAdd?.(id);
    },
    async removeLabel(id, labelId) {
      calls.push('removeLabel');
      map.get(id)?.labels.delete(labelId);
    },
    async moveToState(id, state) {
      calls.push('moveToState');
      const e = map.get(id);
      if (e) e.state = state;
    },
  };
  return { client, map, calls };
}

const only = (id: string): LinearQueueIssue[] => fixture.filter((i) => i.identifier === id);

describe('linear queue ordering', () => {
  it('orders by priority, then order label, then creation date', async () => {
    const { client } = fakeClient(fixture);
    const q = createLinearQueue({ client, linear, claimantId: 'lane-a' });
    expect(await q.list('infra')).toEqual(['ON-14', 'ON-16', 'ON-12', 'ON-13', 'ON-15']);
    const p0 = { ...fixture[0]!, priority: 0 };
    const p4 = { ...fixture[0]!, priority: 4 };
    expect(compareLinearCandidates(p0, p4)).toBeGreaterThan(0);
  });

  it('excludes started, completed and canceled issues', async () => {
    const { client } = fakeClient(fixture);
    const keys = await createLinearQueue({ client, linear }).list('infra');
    for (const k of ['ON-20', 'ON-21', 'ON-22', 'ON-23', 'ON-24']) expect(keys).not.toContain(k);
    const base = fixture[0]!;
    for (const stateType of ['started', 'completed', 'canceled']) {
      expect(isLinearCandidate({ ...base, stateType }, 'factory:ready')).toBe(false);
    }
    expect(isLinearCandidate(base, 'factory:ready')).toBe(true);
  });

  it('falls back to the default lane and sorts lane-first without a lane', async () => {
    expect(
      linearLaneOf(
        fixture.find((i) => i.identifier === 'ON-31')!,
        'lane',
      ),
    ).toBe('default');
    const { client } = fakeClient(fixture);
    const keys = await createLinearQueue({ client, linear }).list();
    expect(keys).toEqual(['ON-31', 'ON-30', 'ON-14', 'ON-16', 'ON-12', 'ON-13', 'ON-15']);
  });
});

describe('linear queue claimNext', () => {
  it('claims ON-12 for the infra lane and moves it to In Progress', async () => {
    const { client, map } = fakeClient(only('ON-12'));
    const claim = await createLinearQueue({ client, linear, claimantId: 'lane-a' }).claimNext('infra');
    expect(claim).toEqual({ key: 'ON-12', decision: { kind: 'build' } });
    const entry = map.get('id-ON-12')!;
    expect(entry.state).toBe('In Progress');
    expect(entry.labels.has(claimedByLabel('lane-a'))).toBe(true);
  });

  it('returns null without writing when the lane is empty', async () => {
    const { client, calls } = fakeClient(only('ON-30'));
    expect(await createLinearQueue({ client, linear }).claimNext('infra')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps a contended claim only for the smallest claimant id', async () => {
    const issues = [...only('ON-12'), ...only('ON-13')];
    const shared = fakeClient(issues);
    const rivalLabel = (c: string): string => claimedByLabel(c);
    // Both adds on ON-12 land before either re-fetch: inject the rival's label on each first add.
    let injected = false;
    shared.client.hooks.afterAdd = (id) => {
      if (injected || id !== 'id-ON-12') return;
      injected = true;
      const labels = shared.map.get(id)!.labels;
      labels.add(rivalLabel('a-host-1'));
      labels.add(rivalLabel('b-host-2'));
    };
    const a = createLinearQueue({ client: shared.client, linear, claimantId: 'a-host-1' });
    const b = createLinearQueue({ client: shared.client, linear, claimantId: 'b-host-2' });
    const [ca, cb] = await Promise.all([a.claimNext('infra'), b.claimNext('infra')]);
    expect(ca?.key).toBe('ON-12');
    expect(cb?.key).toBe('ON-13');
    const held = [...shared.map.get('id-ON-12')!.labels].filter((n) => n.startsWith('factory:claimed-by:'));
    expect(held).toEqual([rivalLabel('a-host-1')]);
  });

  it('returns null when every candidate is lost', async () => {
    const { client, map } = fakeClient(only('ON-12'));
    client.hooks.afterAdd = (id) => map.get(id)!.labels.add(claimedByLabel('a-first'));
    const q = createLinearQueue({ client, linear, claimantId: 'z-late' });
    expect(await q.claimNext('infra')).toBeNull();
    expect(map.get('id-ON-12')!.labels.has(claimedByLabel('z-late'))).toBe(false);
  });

  it('claimNext rejects and writes nothing when listing fails', async () => {
    const { client, calls } = fakeClient([]);
    client.listCandidates = async () => {
      throw new LinearApiError('down');
    };
    await expect(createLinearQueue({ client, linear }).claimNext('infra')).rejects.toBeInstanceOf(LinearApiError);
    expect(calls).toEqual([]);
  });
});

describe('linear queue graphql client', () => {
  const apiKey = 'lin_api_SECRET';
  const respond =
    (body: unknown, status = 200) =>
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const make = (fetchFn: typeof fetch) =>
    createLinearQueueGraphqlClient({ apiKey, linear, project: 'Foreman', fetch: fetchFn });

  it('rejects list with LinearApiError instead of an empty queue', async () => {
    for (const f of [respond({}, 500), respond({ errors: [{ message: `boom ${apiKey}` }] })]) {
      const q = createLinearQueue({ client: make(f), linear });
      const err = await q.list('infra').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(LinearApiError);
      expect((err as Error).message).not.toContain(apiKey);
    }
  });

  it('redacts the key from network errors', async () => {
    const f: typeof fetch = async () => {
      throw new Error(`connect failed for ${apiKey}`);
    };
    await expect(make(f).listCandidates()).rejects.toThrow('connect failed for ***');
  });

  it('maps a response to issues including the parent label group', async () => {
    const node = {
      id: 'i1',
      identifier: 'ON-1',
      priority: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
      state: { type: 'unstarted' },
      labels: {
        nodes: [
          { id: 'l1', name: 'infra', parent: { name: 'lane' } },
          { id: 'l2', name: 'x', parent: null },
        ],
      },
    };
    const f = respond({ data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } });
    expect(await make(f).listCandidates()).toEqual([
      {
        id: 'i1',
        identifier: 'ON-1',
        priority: 2,
        createdAt: node.createdAt,
        stateType: 'unstarted',
        labels: [
          { id: 'l1', name: 'infra', group: 'lane' },
          { id: 'l2', name: 'x' },
        ],
      },
    ]);
  });

  it('throws when the ready queue exceeds the page cap', async () => {
    const f = respond({ data: { issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'c' } } } });
    await expect(make(f).listCandidates()).rejects.toThrow('exceeds 1000');
  });

  it('throws on a malformed response and on null data', async () => {
    await expect(make(respond({ data: { issues: 1 } })).listCandidates()).rejects.toThrow('malformed Linear response');
    await expect(make(respond({ data: null })).listCandidates()).rejects.toThrow('no data');
  });

  it('writes: creates a missing label, adds, removes and moves state', async () => {
    const seen: string[] = [];
    const f: typeof fetch = async (_url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      seen.push(
        query.match(/(teams|issueLabels|issueLabelCreate|issueAddLabel|issueRemoveLabel|issueUpdate|issue)\b/)![1]!,
      );
      const data = query.includes('teams(')
        ? { teams: { nodes: [{ id: 't1', states: { nodes: [{ id: 's1', name: 'In Progress' }] } }] } }
        : query.includes('issueLabels(')
          ? { issueLabels: { nodes: [] } }
          : query.includes('issueLabelCreate')
            ? { issueLabelCreate: { success: true, issueLabel: { id: 'new' } } }
            : query.includes('issueAddLabel')
              ? { issueAddLabel: { success: true } }
              : query.includes('issueRemoveLabel')
                ? { issueRemoveLabel: { success: true } }
                : query.includes('issueUpdate')
                  ? { issueUpdate: { success: true } }
                  : { issue: { labels: { nodes: [{ name: 'a' }] } } };
      return new Response(JSON.stringify({ data }));
    };
    const c = make(f);
    expect(await c.ensureLabel('x')).toBe('new');
    await c.addLabel('i', 'new');
    await c.removeLabel('i', 'new');
    await c.moveToState('i', 'In Progress');
    expect(await c.issueLabels('i')).toEqual(['a']);
    expect(seen).toEqual([
      'teams',
      'issueLabels',
      'issueLabelCreate',
      'issueAddLabel',
      'issueRemoveLabel',
      'issueUpdate',
      'issue',
    ]);
  });

  it('throws when the In Progress state is missing or a mutation fails', async () => {
    const team = { teams: { nodes: [{ id: 't1', states: { nodes: [] } }] } };
    await expect(make(respond({ data: team })).moveToState('i', 'In Progress')).rejects.toThrow(
      'Linear state "In Progress" not found in team ON',
    );
    await expect(
      make(respond({ data: { issueAddLabel: { success: false } } })).addLabel('i', 'l'),
    ).rejects.toBeInstanceOf(LinearApiError);
    await expect(make(respond({ data: { issue: null } })).issueLabels('i')).rejects.toThrow('not found');
    await expect(make(respond({ data: { teams: { nodes: [] } } })).ensureLabel('x')).rejects.toThrow(
      'team ON not found',
    );
  });
});

describe('linear queue lifecycle client methods and lanes (#3918)', () => {
  const apiKey = 'lin_api_SECRET';
  const issueNode = {
    id: 'i1',
    identifier: 'ON-12',
    labels: { nodes: [{ id: 'l1', name: 'factory:ready' }] },
    attachments: { nodes: [{ id: 'a1', metadata: { kind: 'factory-claim-lease' } }] },
  };

  it('createLinearQueueGraphqlClient serves the lifecycle methods over the same endpoint', async () => {
    const seen: Array<{ url: string; auth: string; query: string; variables: Record<string, unknown> }> = [];
    const f: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      seen.push({
        url: String(url),
        auth: new Headers(init?.headers).get('Authorization') ?? '',
        query: body.query,
        variables: body.variables,
      });
      let data: unknown = { teams: { nodes: [{ id: 't1', states: { nodes: [] } }] } };
      if (body.query.includes('issue(id')) data = { issue: issueNode };
      else if (body.query.includes('issues(')) {
        data = { issues: { nodes: [issueNode], pageInfo: { hasNextPage: false } } };
      } else if (body.query.includes('commentCreate')) data = { commentCreate: { success: true } };
      else if (body.query.includes('attachmentCreate')) data = { attachmentCreate: { success: true } };
      else if (body.query.includes('attachmentDelete')) data = { attachmentDelete: { success: true } };
      return new Response(JSON.stringify({ data }), { status: 200 });
    };
    const client = createLinearQueueGraphqlClient({ apiKey, linear, project: 'Foreman', fetch: f });

    expect(await client.findIssue('ON-12')).toEqual({
      id: 'i1',
      identifier: 'ON-12',
      labels: [{ id: 'l1', name: 'factory:ready' }],
      lease: { attachmentId: 'a1', metadata: { kind: 'factory-claim-lease' } },
    });
    expect(await client.listLeasedIssues()).toHaveLength(1);
    await client.addComment('i1', 'hello');
    await client.upsertLeaseAttachment('i1', { kind: 'factory-claim-lease', claimantId: 'h', expiresAt: 5 });
    await client.deleteAttachment('a1');

    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((s) => s.url))).toEqual(new Set(['https://api.linear.app/graphql']));
    expect(seen.every((s) => s.auth === apiKey)).toBe(true);
    expect(seen[3]?.variables).toMatchObject({ url: LINEAR_LEASE_ATTACHMENT_URL, metadata: { expiresAt: 5 } });
  });

  it('findIssue returns null for a missing issue or a not-found error, and rethrows others', async () => {
    const respond = (body: unknown) => async () => new Response(JSON.stringify(body), { status: 200 });
    const make = (f: typeof fetch) => createLinearQueueGraphqlClient({ apiKey, linear, project: 'Foreman', fetch: f });
    expect(await make(respond({ data: { issue: null } })).findIssue('ON-1')).toBeNull();
    expect(await make(respond({ errors: [{ message: 'Entity not found: Issue' }] })).findIssue('ON-1')).toBeNull();
    await expect(make(respond({ errors: [{ message: 'rate limited' }] })).findIssue('ON-1')).rejects.toBeInstanceOf(
      LinearApiError,
    );
  });

  it('lifecycle mutations raise LinearApiError on success=false', async () => {
    const f: typeof fetch = async () =>
      new Response(JSON.stringify({ data: { commentCreate: { success: false } } }), { status: 200 });
    const client = createLinearQueueGraphqlClient({ apiKey, linear, project: 'Foreman', fetch: f });
    await expect(client.addComment('i1', 'x')).rejects.toBeInstanceOf(LinearApiError);
  });

  it('lanes returns the sorted distinct lanes of the candidates', async () => {
    const { client } = fakeClient(fixture);
    const lanes = await createLinearQueue({ client, linear }).lanes();
    expect(lanes).toContain('infra');
    expect(lanes).toEqual([...new Set(lanes)].sort());
  });
});
