import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CAP_PROBE_MS,
  gateBuildOnBreaker,
  MAX_REPORTED_COOLDOWN_MS,
  parseResetCooldownMs,
  ProviderBreaker,
  reportedCooldownMs,
} from './breaker.js';

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs.clear();
});

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'breaker-test-'));
  tempDirs.add(dir);
  return join(dir, 'breaker.json');
}

/** The provider message inside the recorded OpenCode Go usage-cap error event. */
function opencodeCapMessage(): string {
  const raw = readFileSync(
    fileURLToPath(new URL('../__fixtures__/opencode/error-usage-cap.jsonl', import.meta.url)),
    'utf8',
  );
  const event = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { type: string; error?: { data?: { responseBody?: string } } })
    .find((e) => e.type === 'error');
  const body = JSON.parse(event?.error?.data?.responseBody ?? '{}') as { error?: { message?: string } };
  return body.error?.message ?? '';
}

describe('ProviderBreaker', () => {
  it('open reports wasOpen false first, true on a repeat in the window, false after expiry', async () => {
    const file = await tmpFile();
    let t = 1_000_000;
    const breaker = new ProviderBreaker(file, () => t);

    expect(await breaker.open('openai', 'usage_cap', 1000)).toEqual({ wasOpen: false });
    t += 500;
    expect(await breaker.open('openai', 'usage_cap', 1000)).toEqual({ wasOpen: true });
    t += 1000;
    expect(await breaker.open('openai', 'usage_cap', 1000)).toEqual({ wasOpen: false });
  });

  it('open stores cappedUntil and probeDue only when a cap is passed (#3337)', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(file, () => 1_000_000);
    const cappedUntil = new Date(1_000_000 + 5000).toISOString();

    await breaker.open('a', 'usage_cap', 5000, { cappedUntil, probeDue: true });
    await breaker.open('b', 'usage_cap', 5000, { cappedUntil });
    await breaker.open('c', 'rate_limit', 5000);

    const { providers } = JSON.parse(await readFile(file, 'utf-8'));
    expect(providers.a).toMatchObject({ cappedUntil, probeDue: true });
    expect(providers.b.cappedUntil).toBe(cappedUntil);
    expect(providers.b).not.toHaveProperty('probeDue');
    expect(providers.c).not.toHaveProperty('cappedUntil');
    expect(providers.c).not.toHaveProperty('probeDue');
  });

  it('DEFAULT_CAP_PROBE_MS is one hour', () => {
    expect(DEFAULT_CAP_PROBE_MS).toBe(3_600_000);
  });

  it('reports open with remainingMs within the cooldown window', async () => {
    const file = await tmpFile();
    let t = 1_000_000;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t += 100_000;

    const status = await breaker.status('openai');
    expect(status.open).toBe(true);
    if (status.open) {
      expect(status.entry.reason).toBe('usage_cap');
      expect(status.remainingMs).toBe(1_800_000 - 100_000);
    }
  });

  it('closes once after cooldown expiry, prunes the file, and reports closed on a second call', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 1_800_001;

    const firstStatus = await breaker.status('openai');
    expect(firstStatus).toEqual({
      open: false,
      closeCause: 'cooldown',
      justClosed: { reason: 'usage_cap', openedAt: expect.any(String), cooldownMs: 1_800_000 },
    });

    const secondStatus = await breaker.status('openai');
    expect(secondStatus).toEqual({ open: false });
  });

  it('refreshes openedAt when re-opening an already-open provider', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);

    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 500_000;
    await breaker.open('openai', 'usage_cap', 1_800_000);

    const status = await breaker.status('openai');
    expect(status.open).toBe(true);
    if (status.open) expect(status.remainingMs).toBe(1_800_000);
  });

  it('treats a missing file as closed', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(file);
    expect(await breaker.status('openai')).toEqual({ open: false });
    expect(await breaker.list()).toEqual([]);
  });

  it('treats a corrupt (non-JSON) file as closed', async () => {
    const file = await tmpFile();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, 'not json{{{');
    const breaker = new ProviderBreaker(file);
    expect(await breaker.status('openai')).toEqual({ open: false });
    expect(await breaker.list()).toEqual([]);
  });

  it('list() excludes expired entries and never rewrites the file', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 900_000;

    const before = await readFile(file, 'utf-8');
    const list = await breaker.list();
    expect(list).toEqual([
      { provider: 'openai', reason: 'usage_cap', openedAt: expect.any(String), remainingMs: 900_000 },
    ]);
    const after = await readFile(file, 'utf-8');
    expect(after).toBe(before);

    t = 1_800_001;
    const expiredList = await breaker.list();
    expect(expiredList).toEqual([]);
    const stillAfter = await readFile(file, 'utf-8');
    expect(stillAfter).toBe(before);
  });
});

describe('gateBuildOnBreaker', () => {
  it('blocks codex and logs provider_breaker_skip when a provider is open', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 100_000;

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('provider_breaker_skip');
    expect(logs[0][1]).toMatch(/breaker open for openai \(usage_cap\).*29m remaining/);
  });

  it('logs provider_breaker_close and does not block when the breaker just expired', async () => {
    const file = await tmpFile();
    let t = 0;
    const breaker = new ProviderBreaker(file, () => t);
    await breaker.open('openai', 'usage_cap', 1_800_000);
    t = 1_800_001;

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(false);
    expect(logs).toEqual([
      ['provider_breaker_close', 'breaker closed for openai (cause=cooldown) — codex workers eligible again'],
    ]);
  });

  it('logs nothing and does not block when the breaker is closed/absent', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(file);

    const logs: Array<[string, string]> = [];
    const result = await gateBuildOnBreaker({
      breaker,
      providers: ['openai'],
      log: (type, msg) => logs.push([type, msg]),
    });

    expect(result.codexBlocked).toBe(false);
    expect(logs).toEqual([]);
  });
});

describe('parseResetCooldownMs', () => {
  it('parses the recorded OpenCode Go usage-cap fixture message to its reset instant', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    const msg = opencodeCapMessage();
    expect(msg).toContain('resets at 2026-11-01T00:00:00Z');
    expect(parseResetCooldownMs(msg, undefined, now)).toBe(Date.parse('2026-11-01T00:00:00Z') - now + 2 * 60_000);
    expect(parseResetCooldownMs(msg, 0, now)).toBe(86_400_000);
  });

  it('returns null for the recorded fixture message once its reset instant is in the past', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    expect(parseResetCooldownMs(opencodeCapMessage(), undefined, now)).toBeNull();
  });

  it('parses "Resets in 1hr 30min" as 90 minutes', () => {
    expect(parseResetCooldownMs('Resets in 1hr 30min.', 0)).toBe(90 * 60_000);
    expect(parseResetCooldownMs('Resets in 1hr 30min.')).toBe(90 * 60_000 + 2 * 60_000);
  });
  it('parses "Xhr Ymin" and pads with the buffer', () => {
    const text =
      'AI_APICallError: Weekly usage limit reached. Resets in 3hr 17min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_x/go';
    expect(parseResetCooldownMs(text)).toBe((3 * 60 + 17) * 60_000 + 2 * 60_000);
    expect(parseResetCooldownMs('Resets in 3hr 17min')).toBe(11_940_000);
  });

  it('parses minutes-only durations', () => {
    expect(parseResetCooldownMs('Weekly usage limit reached. Resets in 50min.')).toBe(50 * 60_000 + 2 * 60_000);
    expect(parseResetCooldownMs('Weekly usage limit reached. Resets in 10min.')).toBe(10 * 60_000 + 2 * 60_000);
  });

  it('parses odd but real provider output like "1hr 60min" as its literal total', () => {
    expect(parseResetCooldownMs('Resets in 1hr 60min.')).toBe((1 * 60 + 60) * 60_000 + 2 * 60_000);
  });

  it('honors a custom buffer', () => {
    expect(parseResetCooldownMs('Resets in 10min.', 0)).toBe(10 * 60_000);
  });

  it('returns null when there is no reset hint', () => {
    expect(parseResetCooldownMs('AI_APICallError: Service Unavailable')).toBeNull();
    expect(parseResetCooldownMs('')).toBeNull();
  });

  it('returns null when "resets in" appears without a parseable duration', () => {
    expect(parseResetCooldownMs('Your quota resets in a little while.')).toBeNull();
  });

  it('parses an absolute "resets at" ISO instant against the injected now', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    expect(parseResetCooldownMs('Your limit resets at 2026-11-01T00:00:00Z.', undefined, now)).toBe(86_520_000);
    expect(parseResetCooldownMs('Your limit RESETS AT 2026-11-01T00:00:00Z.', undefined, now)).toBe(86_520_000);
    expect(parseResetCooldownMs('Your limit resets at 2026-11-01T02:00:00+02:00.', undefined, now)).toBe(86_520_000);
  });

  it('caps a far-future reset at MAX_REPORTED_COOLDOWN_MS', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    const far = new Date(now + 90 * 24 * 60 * 60_000).toISOString();
    expect(parseResetCooldownMs(`resets at ${far}`, undefined, now)).toBe(MAX_REPORTED_COOLDOWN_MS);
  });

  it('returns null for a reset instant in the past', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    expect(parseResetCooldownMs('resets at 2026-10-30T00:00:00Z', undefined, now)).toBeNull();
    expect(parseResetCooldownMs('resets at 2026-10-31T00:00:00Z', undefined, now)).toBeNull();
  });

  it('returns null for an unparseable or offset-less reset instant', () => {
    const now = Date.parse('2026-10-31T00:00:00Z');
    expect(parseResetCooldownMs('resets at 2026-13-45T99:00:00Z', undefined, now)).toBeNull();
    expect(parseResetCooldownMs('resets at 2026-11-01T00:00:00', undefined, now)).toBeNull();
    expect(parseResetCooldownMs('resets at noon', undefined, now)).toBeNull();
  });
});

describe('reportedCooldownMs', () => {
  const now = Date.parse('2026-10-18T22:39:00Z');

  it('prefers a future resetAt plus the buffer, capped', () => {
    expect(reportedCooldownMs('2026-10-20T12:00:00.000Z', 'Resets in 1hr', now)).toBe(
      Date.parse('2026-10-20T12:02:00Z') - now,
    );
    expect(reportedCooldownMs('2099-01-01T00:00:00Z', undefined, now)).toBe(MAX_REPORTED_COOLDOWN_MS);
  });

  it('falls back to the detail hint, then null', () => {
    expect(reportedCooldownMs('2026-10-01T00:00:00Z', 'Resets in 1hr', now)).toBe(62 * 60_000);
    expect(reportedCooldownMs('garbage', 'nothing', now)).toBeNull();
    expect(reportedCooldownMs(undefined, undefined, now)).toBeNull();
  });
});

describe('auth entries (#3232)', () => {
  const HOUR = 60 * 60_000;

  it('openAuth stores until and the fingerprint, and reports wasOpen false then true', async () => {
    const file = await tmpFile();
    const breaker = new ProviderBreaker(
      file,
      () => 0,
      async () => 'fp-1',
    );
    expect(await breaker.openAuth('anthropic', 'local_auth')).toEqual({ wasOpen: false });
    expect(await breaker.openAuth('anthropic', 'local_auth')).toEqual({ wasOpen: true });
    const raw = JSON.parse(await readFile(file, 'utf8')) as { providers: Record<string, Record<string, unknown>> };
    expect(raw.providers.anthropic).toMatchObject({
      until: 'credentials-change',
      credentialFingerprint: 'fp-1',
      cooldownMs: 0,
    });
  });

  it('openAuth announces again when the stored fingerprint differs', async () => {
    const file = await tmpFile();
    let fp = 'fp-1';
    const breaker = new ProviderBreaker(
      file,
      () => 0,
      async () => fp,
    );
    await breaker.openAuth('anthropic', 'local_auth');
    fp = 'fp-2';
    expect(await breaker.openAuth('anthropic', 'local_auth')).toEqual({ wasOpen: false });
  });

  it('an auth entry stays open after 48h until the credential fingerprint changes, then closes with creds_changed', async () => {
    const file = await tmpFile();
    let t = 0;
    let fp = 'fp-1';
    const breaker = new ProviderBreaker(
      file,
      () => t,
      async () => fp,
    );
    await breaker.openAuth('anthropic', 'local_auth');
    t = 48 * HOUR;
    const open = await breaker.status('anthropic');
    expect(open).toMatchObject({ open: true, remainingMs: MAX_REPORTED_COOLDOWN_MS });
    fp = 'fp-2';
    const closed = await breaker.status('anthropic');
    expect(closed).toMatchObject({ open: false, closeCause: 'creds_changed' });
    expect(await breaker.status('anthropic')).toEqual({ open: false });
  });

  it('reset removes the entry and returns it, or undefined when absent', async () => {
    const breaker = new ProviderBreaker(
      await tmpFile(),
      () => 0,
      async () => 'fp',
    );
    expect(await breaker.reset('anthropic')).toBeUndefined();
    await breaker.openAuth('anthropic', 'local_auth');
    expect(await breaker.reset('anthropic')).toMatchObject({ until: 'credentials-change' });
    expect(await breaker.status('anthropic')).toEqual({ open: false });
  });

  it('list includes auth entries with until, and leaves timed entries unchanged', async () => {
    const breaker = new ProviderBreaker(
      await tmpFile(),
      () => 0,
      async () => 'fp',
    );
    await breaker.openAuth('anthropic', 'local_auth');
    await breaker.open('openai', 'rate_limit', 1000);
    const list = await breaker.list();
    expect(list.find((b) => b.provider === 'anthropic')).toMatchObject({ until: 'credentials-change' });
    expect(list.find((b) => b.provider === 'openai')).toMatchObject({ remainingMs: 1000 });
    expect(list.find((b) => b.provider === 'openai')?.until).toBeUndefined();
  });

  it('a timed close carries closeCause cooldown', async () => {
    let t = 0;
    const breaker = new ProviderBreaker(await tmpFile(), () => t);
    await breaker.open('openai', 'rate_limit', 1000);
    t = 1001;
    expect(await breaker.status('openai')).toMatchObject({ open: false, closeCause: 'cooldown' });
  });

  it('gateBuildOnBreaker prints "until credentials change" for an auth entry', async () => {
    const breaker = new ProviderBreaker(
      await tmpFile(),
      () => 0,
      async () => 'fp',
    );
    await breaker.openAuth('openai', 'local_auth');
    const logs: string[] = [];
    const result = await gateBuildOnBreaker({ breaker, providers: ['openai'], log: (_t, msg) => logs.push(msg) });
    expect(result.codexBlocked).toBe(true);
    expect(logs[0]).toContain('until credentials change');
  });
});
