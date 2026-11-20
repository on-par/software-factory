import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { policy, ports, request, resetCiReworkMocks, shipPhase, tmp, type Log } from './ci-rework-test-helpers.js';
import { runIssue } from './run-issue.js';

afterAll(() => tmp.cleanup());
beforeEach(resetCiReworkMocks);

function captureWatchCi(): (boolean | undefined)[] {
  const watched: (boolean | undefined)[] = [];
  shipPhase.mockImplementation(async (opts) => {
    watched.push(opts.watchCI);
    return { ok: true, prNumber: 9 };
  });
  return watched;
}

describe('ship.watchCi (#4304)', () => {
  it('ship.watchCi false ships without the CI watch and reports CI not watched', async () => {
    const watched = captureWatchCi();
    const events = new Map<string, string>();
    const log: Log = (kind, message) => {
      events.set(kind, message);
    };
    const outcome = await runIssue({ ...request, shipWatchCi: false }, policy, ports(log));
    expect(watched).toEqual([false]);
    expect(outcome).toMatchObject({ state: 'ready', ciWatched: false });
    expect(events.get('skip-ci')).toContain('ship.watchCi');
    expect(events.get('ready')).toContain('(CI not watched)');
  });

  it('ci.skip still skips the SHIP CI watch without a ciWatched marker', async () => {
    const watched = captureWatchCi();
    const events = new Map<string, string>();
    const log: Log = (kind, message) => {
      events.set(kind, message);
    };
    const outcome = await runIssue({ ...request, skipCI: true, shipWatchCi: false }, policy, ports(log));
    expect(watched).toEqual([false]);
    expect(outcome).toMatchObject({ state: 'ready' });
    expect(outcome).not.toHaveProperty('ciWatched');
    expect(events.get('skip-ci')).toBe('skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify');
  });

  it('default request watches CI', async () => {
    const watched = captureWatchCi();
    const outcome = await runIssue(
      request,
      policy,
      ports(() => {}),
    );
    expect(watched).toEqual([true]);
    expect(outcome).not.toHaveProperty('ciWatched');
  });
});
