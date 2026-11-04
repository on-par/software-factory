import { describe, expect, it } from 'vitest';

import type { LinearTrackerConfig } from '../config/tracker-section.js';
import { LINEAR_GRAPHQL_URL, probeLinearSetup } from './linear-preflight.js';

const KEY = 'lin_api_SECRET123';
const linear: LinearTrackerConfig = {
  teamKey: 'ENG',
  projects: { Mapped: 'o/r', 'proj-id': 'o/r2' },
  readyLabel: 'factory:ready',
  laneLabelGroup: 'lane',
  states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
};

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const page = (nodes: unknown[], next?: string, teams: unknown[] = [{ id: 't' }]) => ({
  data: {
    teams: { nodes: teams },
    issues: { nodes, pageInfo: { hasNextPage: next !== undefined, endCursor: next ?? null } },
  },
});
const fakeFetch = (...responses: Response[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    return next;
  };
  return { fn, calls };
};

describe('probeLinearSetup (#3891)', () => {
  it('reports projects with ready issues that are not in the project map', async () => {
    const { fn } = fakeFetch(
      json(
        page([
          { project: { id: 'a', name: 'Mapped' } },
          { project: { id: 'proj-id', name: 'ById' } },
          { project: { id: 'b', name: 'Zed' } },
          { project: { id: 'c', name: 'Alpha' } },
          { project: { id: 'b', name: 'Zed' } },
          { project: null },
        ]),
      ),
    );
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fn)).toEqual({
      kind: 'ok',
      readyIssues: 6,
      unmappedProjects: ['Alpha', 'Zed'],
    });
  });

  it('is unauthorized on 401 and on an AUTHENTICATION_ERROR code', async () => {
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fakeFetch(json({}, 401)).fn)).toEqual({
      kind: 'unauthorized',
    });
    const body = { errors: [{ message: 'x', extensions: { code: 'AUTHENTICATION_ERROR' } }] };
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fakeFetch(json(body, 200)).fn)).toEqual({
      kind: 'unauthorized',
    });
  });

  it('reports a missing team', async () => {
    const { fn } = fakeFetch(json(page([], undefined, [])));
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fn)).toEqual({ kind: 'team-missing', teamKey: 'ENG' });
  });

  it('follows endCursor across pages', async () => {
    const { fn, calls } = fakeFetch(
      json(page([{ project: { id: 'a', name: 'P1' } }], 'cur1')),
      json(page([{ project: { id: 'b', name: 'P2' } }])),
    );
    const result = await probeLinearSetup({ apiKey: KEY, linear }, fn);
    expect(result).toEqual({ kind: 'ok', readyIssues: 2, unmappedProjects: ['P1', 'P2'] });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1]?.init.body)).variables.after).toBe('cur1');
  });

  it('redacts the key from network error messages', async () => {
    const fn: typeof fetch = async () => {
      throw new Error(`connect failed for ${KEY}`);
    };
    const result = await probeLinearSetup({ apiKey: KEY, linear }, fn);
    expect(result).toEqual({ kind: 'error', message: 'connect failed for ***' });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it('classifies other failures as errors', async () => {
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fakeFetch(json({}, 500)).fn)).toEqual({
      kind: 'error',
      message: 'HTTP 500',
    });
    expect(await probeLinearSetup({ apiKey: KEY, linear }, fakeFetch(new Response('<html>')).fn)).toMatchObject({
      kind: 'error',
    });
    expect(
      await probeLinearSetup({ apiKey: KEY, linear }, fakeFetch(json({ errors: [{ message: 'boom' }] })).fn),
    ).toEqual({ kind: 'error', message: 'boom' });
  });

  it('sends the key as Authorization and the team, label and state variables', async () => {
    const { fn, calls } = fakeFetch(json(page([])));
    await probeLinearSetup({ apiKey: KEY, linear }, fn);
    expect(calls[0]?.url).toBe(LINEAR_GRAPHQL_URL);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: KEY });
    expect(JSON.parse(String(calls[0]?.init.body)).variables).toEqual({
      team: 'ENG',
      label: 'factory:ready',
      state: 'Todo',
      after: null,
    });
  });
});
