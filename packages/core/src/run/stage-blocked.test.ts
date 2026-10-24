import { workKeyFromIssue } from '../work/work-key.js';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import type { EventKind } from '../events/kinds.js';
import { ProviderBreaker } from '../router/breaker.js';
import {
  allProvidersDown,
  allProvidersDownMessage,
  allProvidersDownPayload,
  providerCapGate,
  stageBlocked,
} from './stage-blocked.js';

const NOW = Date.parse('2026-10-19T05:00:00.000Z');
const HOUR = 60 * 60_000;
const tempDirs = createTempDirs();
const dir = tempDirs.makeSync('stage-blocked-');
afterAll(() => tempDirs.cleanup());
let counter = 0;

const PROVIDERS: Record<string, string> = { 'claude-a': 'anthropic', 'claude-b': 'anthropic', 'gpt-a': 'openai' };
const router = {
  registryRef: { get: (id: string) => (PROVIDERS[id] ? { provider: PROVIDERS[id] } : undefined) },
  resolveAll: () => ['claude-a', 'gpt-a'],
} as never;

function freshBreaker(): ProviderBreaker {
  counter += 1;
  return new ProviderBreaker(join(dir, `breaker-${counter}.json`), () => NOW);
}

describe('stageBlocked', () => {
  it('skips an open provider, logs it, and is not blocked when another candidate is closed', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    const logs: Array<[EventKind, string]> = [];
    const r = await stageBlocked('plan', {
      router,
      breaker,
      candidates: ['claude-a', 'gpt-a'],
      failoverEnabled: true,
      log: (t, m) => logs.push([t, m]),
      now: () => NOW,
    });
    expect(r.blocked).toBe(false);
    expect([...r.skip]).toEqual(['anthropic']);
    expect(r.providers).toEqual(['anthropic']);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('provider_breaker_skip');
    expect(logs[0][1]).toContain('anthropic');
    expect(logs[0][1]).toContain('PLAN');
  });

  it('blocks with the earliest reset when every provider is open on a timed reason', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', 2 * HOUR);
    await breaker.open('openai', 'rate_limit', 4 * HOUR);
    const r = await stageBlocked('plan', {
      router,
      breaker,
      candidates: ['claude-a', 'claude-b', 'gpt-a'],
      failoverEnabled: true,
      now: () => NOW,
    });
    expect(r).toMatchObject({ blocked: true, providers: ['anthropic', 'openai'] });
    expect(r.skip.size).toBe(0);
    expect(r.nextAvailableAt).toBe(new Date(NOW + 2 * HOUR).toISOString());
  });

  it('takes nextAvailableAt from the timed entry when the other open provider is on timeout', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'timeout', HOUR);
    await breaker.open('openai', 'usage_cap', 3 * HOUR);
    const r = await stageBlocked('build', {
      router,
      breaker,
      candidates: ['claude-a', 'gpt-a'],
      failoverEnabled: true,
      now: () => NOW,
    });
    expect(r.blocked).toBe(true);
    expect(r.nextAvailableAt).toBe(new Date(NOW + 3 * HOUR).toISOString());
  });

  it('reports no reset when every open provider is on an untimed reason', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'timeout', HOUR);
    await breaker.open('openai', 'unavailable', HOUR);
    const r = await stageBlocked('plan', {
      router,
      breaker,
      candidates: ['claude-a', 'gpt-a'],
      failoverEnabled: true,
      now: () => NOW,
    });
    expect(r.blocked).toBe(true);
    expect(r.nextAvailableAt).toBeUndefined();
  });

  it('counts only the first provider when failover is disabled, and never skips', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    const deps = { router, breaker, candidates: ['claude-a', 'gpt-a'], failoverEnabled: false, now: () => NOW };
    const first = await stageBlocked('plan', deps);
    expect(first.blocked).toBe(true);
    expect(first.skip.size).toBe(0);
    expect(first.nextAvailableAt).toBe(new Date(NOW + HOUR).toISOString());

    const other = freshBreaker();
    await other.open('openai', 'usage_cap', HOUR);
    const second = await stageBlocked('plan', { ...deps, breaker: other });
    expect(second).toMatchObject({ blocked: false, providers: [] });
    expect(second.skip.size).toBe(0);
  });

  it('is not blocked for empty candidates or unregistered model ids', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    for (const candidates of [[], ['nope']]) {
      const r = await stageBlocked('plan', { router, breaker, candidates, failoverEnabled: true, now: () => NOW });
      expect(r).toEqual({ blocked: false, providers: [], open: [], skip: new Set() });
    }
  });

  it('counts an expired entry as closed', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    const r = await stageBlocked('plan', {
      router,
      breaker: new ProviderBreaker(join(dir, `breaker-${counter}.json`), () => NOW + 2 * HOUR),
      candidates: ['claude-a', 'gpt-a'],
      failoverEnabled: true,
      now: () => NOW + 2 * HOUR,
    });
    expect(r.blocked).toBe(false);
    expect(r.providers).toEqual([]);
  });
});

describe('allProvidersDown', () => {
  it('allProvidersDown returns the earliest known reset when one down provider is timed and the other untimed', async () => {
    const breaker = freshBreaker();
    const resetAt = Date.parse('2026-10-19T12:00:00.000Z');
    await breaker.open('anthropic', 'usage_cap', resetAt - NOW);
    await breaker.openUntilCredentialsChange('openai', 'error');
    const r = await allProvidersDown('plan', {
      router,
      breaker,
      candidates: ['claude-a', 'gpt-a'],
      failoverEnabled: true,
      now: () => NOW,
    });
    expect(r.down).toBe(true);
    expect(r.earliestResetAt).toBe(new Date(resetAt).toISOString());
    expect(r.providers).toEqual([
      { provider: 'anthropic', reason: 'usage_cap', until: new Date(resetAt).toISOString() },
      { provider: 'openai', reason: 'error', until: 'credentials-change' },
    ]);
  });

  it('is down without a reset when every open provider is untimed, and not down for a zero-provider stage', async () => {
    const breaker = freshBreaker();
    await breaker.openUntilCredentialsChange('anthropic', 'error');
    await breaker.open('openai', 'timeout', HOUR);
    const deps = { router, breaker, failoverEnabled: true, now: () => NOW };
    const r = await allProvidersDown('plan', { ...deps, candidates: ['claude-a', 'gpt-a'] });
    expect(r.down).toBe(true);
    expect(r.earliestResetAt).toBeUndefined();
    expect((await allProvidersDown('plan', { ...deps, candidates: ['unknown'] })).down).toBe(false);
  });
});

describe('providerCapGate', () => {
  const request = {
    issue: workKeyFromIssue(7),
    branch: 'issue-7',
    codexDisabled: false,
    failover: { enabled: true },
    modelPins: {},
  };
  const capped = (reason: string) => Object.assign(new Error('x'), { reason, attempts: [] });

  it('releases a blocked stage, and afterFailure releases a provider-level failure of the watched stage', async () => {
    const breaker = freshBreaker();
    const logs: EventKind[] = [];
    const gate = providerCapGate(router, breaker, request, (t) => logs.push(t));
    const open = await gate.enterPlan(undefined, () => {});
    expect(open.released).toBeUndefined();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    await breaker.open('openai', 'usage_cap', 2 * HOUR);
    const after = (await gate.afterFailure(capped('usage_cap'), 'plan', 'claude'))?.released;
    expect(after).toMatchObject({ state: 'released', reason: 'provider-cap', route: 'claude', branch: 'issue-7' });
    expect(logs).toContain('provider-cap-released');
  });

  it('does not release for other reasons, the ship phase, only_metered_left, or an unwatched stage', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    await breaker.open('openai', 'usage_cap', HOUR);
    const gate = providerCapGate(router, breaker, request, () => {});
    expect(await gate.afterFailure(capped('usage_cap'), 'plan', undefined)).toBeUndefined();
    await gate.enterPlan(undefined, () => {});
    expect(await gate.afterFailure(capped('error'), 'plan', undefined)).toBeUndefined();
    expect(await gate.afterFailure(new Error('plain'), 'plan', undefined)).toBeUndefined();
    expect(await gate.afterFailure(capped('usage_cap'), 'ship', undefined)).toBeUndefined();
  });

  it('afterFailure parks only_metered_left as all_providers_down, naming the metered providers', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    const gate = providerCapGate(router, breaker, request, () => {});
    await gate.enterPlan(undefined, () => {});
    const metered = Object.assign(capped('usage_cap'), { detail: 'only_metered_left' });
    const verdict = await gate.afterFailure(metered, 'plan', undefined);
    expect(verdict?.released).toBeUndefined();
    expect(verdict?.down).toEqual({
      stage: 'plan',
      detail: 'only_metered_left',
      providers: [
        { provider: 'anthropic', reason: 'usage_cap', until: expect.any(String) },
        { provider: 'openai', reason: 'metered', until: null },
      ],
    });
    expect(allProvidersDownMessage(verdict!.down!, workKeyFromIssue(7))).toContain('metered and are never used');
    expect(allProvidersDownPayload(verdict!.down!, workKeyFromIssue(9)).issue).toBe(9);
    expect(
      await gate.afterFailure(Object.assign(capped('usage_cap'), { detail: 'other' }), 'plan', undefined),
    ).toBeUndefined();
  });

  it('enter returns a down verdict when every provider is untimed-open, and a release when one is timed', async () => {
    const breaker = freshBreaker();
    await breaker.openUntilCredentialsChange('anthropic', 'error');
    await breaker.openUntilCredentialsChange('openai', 'error');
    const gate = providerCapGate(router, breaker, request, () => {});
    const verdict = await gate.enterPlan(undefined, () => {});
    expect(verdict.released).toBeUndefined();
    expect(verdict.down).toMatchObject({ stage: 'plan', detail: 'untimed_breakers' });
    expect(allProvidersDownMessage(verdict.down!, workKeyFromIssue(7))).toContain('until credentials change');
    expect((await gate.afterFailure(capped('unavailable'), 'plan', undefined))?.down?.detail).toBe('untimed_breakers');
    await breaker.open('anthropic', 'usage_cap', HOUR);
    expect((await gate.enterPlan(undefined, () => {})).released).toMatchObject({ reason: 'provider-cap' });
  });

  it('watchCheck gates the CHECK stage on the build route models', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'rate_limit', HOUR);
    await breaker.open('openai', 'rate_limit', HOUR);
    const gate = providerCapGate(router, breaker, request, () => {});
    gate.watchCheck('codex', 'gpt-a');
    expect((await gate.afterFailure(capped('rate_limit'), 'check', 'codex'))?.released).toMatchObject({
      reason: 'provider-cap',
    });
    gate.watchCheck('command', undefined);
    expect(await gate.afterFailure(capped('rate_limit'), 'check', 'command')).toBeUndefined();
  });

  it('enterBuild releases a blocked build, includes the ladder when failover is on, and skips the command route', async () => {
    const breaker = freshBreaker();
    await breaker.open('anthropic', 'usage_cap', HOUR);
    await breaker.open('openai', 'usage_cap', 2 * HOUR);
    const gate = providerCapGate(router, breaker, request, () => {});
    expect((await gate.enterBuild('claude', 'claude-a', undefined, false)).released).toMatchObject({
      reason: 'provider-cap',
      providers: ['anthropic', 'openai'],
    });
    expect((await gate.enterBuild('command', undefined, undefined, false)).released).toBeUndefined();
  });

  it('does not count the ladder for a failover-disabled run', async () => {
    const breaker = freshBreaker();
    await breaker.open('openai', 'usage_cap', HOUR);
    const gate = providerCapGate(router, breaker, { ...request, failover: { enabled: false } }, () => {});
    expect((await gate.enterBuild('claude', 'claude-a', undefined, false)).released).toBeUndefined();
  });
});
