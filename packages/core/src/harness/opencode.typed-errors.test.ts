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
