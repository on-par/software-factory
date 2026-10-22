import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeContractRequest } from './contract.js';
import { HarnessError } from './index.js';
import { OpenCodeHarness } from './opencode.js';

const readFixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../__fixtures__/opencode/${name}`, import.meta.url)), 'utf8');

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string }[] = [];
  const fn = async (cmd: string) => {
    if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
    calls.push({ cmd });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('OpenCodeHarness typed error events', () => {
  const rateLimitTyped = readFixture('error-typed-rate-limit.jsonl');
  const run = (exec: () => Promise<never>) => new OpenCodeHarness(exec).run(makeContractRequest()).catch((e) => e);
  const runFailing = (stdout: string) =>
    run(async () => {
      throw Object.assign(new Error('boom'), { code: 1, stderr: '', stdout });
    });

  it('classifies a provider.rate-limit error event as rate_limit', async () => {
    const err: any = await runFailing(rateLimitTyped);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('rate_limit');
  });

  it('classifies a provider.quota error event as usage_cap', async () => {
    const err: any = await runFailing(readFixture('error-typed-quota.jsonl'));
    expect(err.reason).toBe('usage_cap');
  });

  it('classifies a provider.auth 401 error event as local_auth', async () => {
    const err: any = await runFailing(readFixture('error-typed-auth.jsonl'));
    expect(err.reason).toBe('local_auth');
  });

  it('classifies an exit-0 provider.connect error event as unavailable without the nudge retry', async () => {
    const rec = recordingExec({ stdout: readFixture('error-typed-connect.jsonl') });
    const err: any = await new OpenCodeHarness(rec.fn as any).run(makeContractRequest()).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('unavailable');
    expect(rec.calls).toHaveLength(1);
    expect(err.details.exitCode).toBe(0);
  });

  it('still classifies a killed exec as timeout when stdout carries a typed error event', async () => {
    const err: any = await run(async () => {
      throw Object.assign(new Error('killed'), { killed: true, stdout: rateLimitTyped });
    });
    expect(err.reason).toBe('timeout');
  });

  it('keeps exit code 124 as timeout when stdout carries a typed error event', async () => {
    const err: any = await run(async () => {
      throw Object.assign(new Error('timed out'), { code: 124, stderr: '', stdout: rateLimitTyped });
    });
    expect(err.reason).toBe('timeout');
  });

  it('falls back to classifyFailure for an unmapped type', async () => {
    const err: any = await runFailing(
      '{"type":"error","error":{"type":"provider.content-filter","data":{"message":"rate limit exceeded"}}}\n',
    );
    expect(err.reason).toBe('rate_limit');
  });
});

describe('OpenCode classifyError (#3336)', () => {
  const NOW = Date.parse('2026-10-20T13:00:00Z');
  const failing = (stdout: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error('boom'), { code: 1, stderr: '', stdout, ...extra });
  const harnessFor = (rejection: unknown) =>
    new OpenCodeHarness(
      async () => {
        throw rejection;
      },
      async () => undefined,
      () => NOW,
    );
  const thrown = async (fixture: string, extra: Record<string, unknown> = {}) => {
    const rejection = failing(readFixture(fixture), extra);
    const harness = harnessFor(rejection);
    const err: any = await harness.run(makeContractRequest()).catch((e) => e);
    return { harness, rejection, err };
  };

  it('OpenCode Go monthly cap classifies as usage_cap with the reported resetAt (2026-10-20)', async () => {
    const { harness, rejection, err } = await thrown('error-typed-quota-resets-at.jsonl');
    expect(harness.classifyError(rejection)).toMatchObject({
      kind: 'usage_cap',
      reason: 'usage_cap',
      resetAt: '2026-11-01T00:00:00.000Z',
    });
    expect(err.details).toMatchObject({ kind: 'usage_cap', resetAt: '2026-11-01T00:00:00.000Z' });
  });

  it('OpenCode weekly cap "Resets in 3hr 17min" classifies with resetAt now + duration (2026-10-20)', async () => {
    const { harness, rejection, err } = await thrown('error-typed-quota-resets-in.jsonl');
    expect(harness.classifyError(rejection).resetAt).toBe('2026-10-20T16:17:00.000Z');
    expect(err.details.resetAt).toBe('2026-10-20T16:17:00.000Z');
  });

  it('OpenCode provider.quota with no reset text classifies as usage_cap without resetAt', async () => {
    const { harness, rejection, err } = await thrown('error-typed-quota.jsonl');
    const failure = harness.classifyError(rejection);
    expect(failure.kind).toBe('usage_cap');
    expect('resetAt' in failure).toBe(false);
    expect(err.details.kind).toBe('usage_cap');
    expect(err.details.resetAt).toBeUndefined();
  });

  it('classifies provider.rate-limit as rate_limit without resetAt', async () => {
    const { harness, rejection } = await thrown('error-typed-rate-limit.jsonl');
    const failure = harness.classifyError(rejection);
    expect(failure.kind).toBe('rate_limit');
    expect('resetAt' in failure).toBe(false);
  });

  it('classifies an untyped monthly-limit APIError with its reset', async () => {
    const { harness, rejection } = await thrown('error-usage-cap.jsonl');
    expect(harness.classifyError(rejection)).toMatchObject({
      kind: 'usage_cap',
      resetAt: '2026-11-01T00:00:00.000Z',
    });
  });

  it('a killed exec is a timeout, unavailable, with no resetAt', async () => {
    const { harness, rejection, err } = await thrown('error-typed-quota-resets-at.jsonl', { killed: true });
    const failure = harness.classifyError(rejection);
    expect(failure).toMatchObject({ kind: 'unavailable', reason: 'timeout' });
    expect('resetAt' in failure).toBe(false);
    expect(err.details.resetAt).toBeUndefined();
  });

  it('keeps the kind and resetAt of an already-tagged HarnessError', () => {
    const tagged = new HarnessError('x', 'usage_cap', { kind: 'usage_cap', resetAt: '2026-11-02T00:00:00Z' });
    expect(harnessFor(null).classifyError(tagged)).toMatchObject({
      kind: 'usage_cap',
      resetAt: '2026-11-02T00:00:00.000Z',
    });
  });

  it('classifies an untagged HarnessError from its details text', () => {
    const untagged = new HarnessError('x', 'usage_cap', { diagnostic: 'Resets in 1hr 0min' });
    expect(harnessFor(null).classifyError(untagged).resetAt).toBe('2026-10-20T14:00:00.000Z');
  });

  it('never throws on a plain Error or null', () => {
    const harness = harnessFor(null);
    expect(harness.classifyError(new Error('plain')).kind).toBeDefined();
    expect(harness.classifyError(null).kind).toBeDefined();
  });

  it('tags an exit-0 error event with kind and resetAt', async () => {
    const harness = new OpenCodeHarness(
      async () => ({ stdout: readFixture('error-typed-quota-resets-at.jsonl'), stderr: '' }),
      async () => undefined,
      () => NOW,
    );
    const err: any = await harness.run(makeContractRequest()).catch((e) => e);
    expect(err.details).toMatchObject({ kind: 'usage_cap', resetAt: '2026-11-01T00:00:00.000Z' });
  });
});
