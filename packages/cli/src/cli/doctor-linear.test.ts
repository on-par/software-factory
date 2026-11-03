import type { LinearPreflightResult, TrackerConfig } from '@on-par/factory-core/internal';
import { describe, expect, it, vi } from 'vitest';

import { linearTrackerChecks } from './doctor-linear.js';

const tracker: TrackerConfig = {
  kind: 'linear',
  linear: {
    teamKey: 'ENG',
    projects: {},
    readyLabel: 'factory:ready',
    laneLabelGroup: 'lane',
    states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
  },
};
const probeOf = (result: LinearPreflightResult) => vi.fn(async () => result);

describe('linearTrackerChecks (#3891)', () => {
  it('returns no rows and never probes for a github tracker', async () => {
    const probe = probeOf({ kind: 'ok', readyIssues: 0, unmappedProjects: [] });
    expect(await linearTrackerChecks({ kind: 'github' }, { LINEAR_API_KEY: 'k' }, probe)).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('fails only the Linear tracker row with a fix-it when LINEAR_API_KEY is unset', async () => {
    for (const env of [{}, { LINEAR_API_KEY: '' }, { LINEAR_API_KEY: '   ' }]) {
      const probe = probeOf({ kind: 'ok', readyIssues: 0, unmappedProjects: [] });
      const rows = await linearTrackerChecks(tracker, env, probe);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ name: 'Linear tracker', ok: false, section: 'Repo' });
      expect(rows[0]?.detail).toContain('LINEAR_API_KEY');
      expect(rows[0]?.fix).toBeTruthy();
      expect(probe).not.toHaveBeenCalled();
    }
  });

  it('reports a rejected key by variable name and never prints its value', async () => {
    const rows = await linearTrackerChecks(
      tracker,
      { LINEAR_API_KEY: 'lin_api_SECRET123' },
      probeOf({ kind: 'unauthorized' }),
    );
    expect(rows[0]).toMatchObject({ ok: false, detail: 'Linear rejected LINEAR_API_KEY' });
    expect(JSON.stringify(rows)).not.toContain('lin_api_SECRET123');
  });

  it('names each unmapped project that has ready issues', async () => {
    const rows = await linearTrackerChecks(
      tracker,
      { LINEAR_API_KEY: 'k' },
      probeOf({ kind: 'ok', readyIssues: 3, unmappedProjects: ['A', 'B'] }),
    );
    expect(rows[0]).toMatchObject({ ok: true, detail: 'team ENG: 3 ready issue(s)' });
    expect(rows[1]).toMatchObject({
      name: 'Linear project mapping',
      ok: false,
      detail: 'ready issues in project(s) with no repo mapping: A, B',
    });
  });

  it('reports a missing team', async () => {
    const rows = await linearTrackerChecks(
      tracker,
      { LINEAR_API_KEY: 'k' },
      probeOf({ kind: 'team-missing', teamKey: 'ENG' }),
    );
    expect(rows).toMatchObject([{ ok: false, detail: 'Linear team ENG not found' }]);
  });

  it('makes a probe error an optional row', async () => {
    const rows = await linearTrackerChecks(
      tracker,
      { LINEAR_API_KEY: 'k' },
      probeOf({ kind: 'error', message: 'down' }),
    );
    expect(rows).toMatchObject([{ ok: false, optional: true, detail: 'could not reach Linear: down' }]);
  });

  it('passes when every project is mapped', async () => {
    const rows = await linearTrackerChecks(
      tracker,
      { LINEAR_API_KEY: 'k' },
      probeOf({ kind: 'ok', readyIssues: 1, unmappedProjects: [] }),
    );
    expect(rows[1]).toMatchObject({ ok: true, detail: 'every project with ready issues is mapped' });
  });
});
