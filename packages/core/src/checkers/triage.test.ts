import { describe, expect, it } from 'vitest';

import type { CheckerOutput, CheckSummary } from '../types/index.js';
import { checkInfraParkMessage, triageCheckFailure, triageLaneFailures } from './triage.js';

const fail = (details: string, extra: Partial<CheckerOutput> = {}): CheckerOutput => ({
  checker: 'tests',
  result: 'FAIL',
  details,
  ...extra,
});

describe('triageCheckFailure (#3371)', () => {
  it('classes a timeout as infra/timeout', () => {
    expect(triageCheckFailure(fail('', { timedOut: true }))).toEqual({
      class: 'infra',
      kind: 'timeout',
      line: 'timed out',
    });
    expect(triageCheckFailure(fail('\n  ran too long\nmore', { timedOut: true }))).toMatchObject({
      kind: 'timeout',
      line: 'ran too long',
    });
  });

  it.each([
    'read ECONNRESET',
    'connect ETIMEDOUT 1.2.3.4:443',
    'getaddrinfo EAI_AGAIN registry.npmjs.org',
    'getaddrinfo ENOTFOUND registry.npmjs.org',
    'Error: socket hang up',
    'ERR_PNPM_META_FETCH_FAIL GET https://registry',
    'ERR_PNPM_FETCH_503 GET https://registry',
    'npm error network request failed',
  ])('classes %s as infra/network', (line) => {
    expect(triageCheckFailure(fail(`start\n  ${line}\nend`))).toEqual({ class: 'infra', kind: 'network', line });
  });

  it('classes command not found as infra/missing-tool', () => {
    expect(triageCheckFailure(fail('sh: tsc: command not found'))).toEqual({
      class: 'infra',
      kind: 'missing-tool',
      line: 'sh: tsc: command not found',
    });
  });

  it('prefers the first network line over assertion text', () => {
    expect(triageCheckFailure(fail('AssertionError: x\nread ECONNRESET\nread ECONNRESET again'))).toMatchObject({
      kind: 'network',
      line: 'read ECONNRESET',
    });
  });

  it.each([['AssertionError: expected 1 to be 2'], ["Cannot find module 'left-pad'"], [''], ['read econnreset']])(
    'classes %j as code',
    (details) => {
      expect(triageCheckFailure(fail(details))).toEqual({ class: 'code' });
    },
  );

  it('classes PASS and SKIP as code', () => {
    expect(triageCheckFailure({ checker: 'x', result: 'PASS', details: 'ECONNRESET' })).toEqual({ class: 'code' });
    expect(triageCheckFailure({ checker: 'x', result: 'SKIP', details: 'ECONNRESET' })).toEqual({ class: 'code' });
  });
});

describe('triageLaneFailures', () => {
  it('covers FAIL results only', () => {
    const summary: CheckSummary = {
      failures: 2,
      passes: 1,
      skips: 0,
      total: 3,
      results: [
        { checker: 'lint', result: 'PASS', details: '' },
        fail('read ECONNRESET'),
        { checker: 'compile', result: 'FAIL', details: 'TS2322' },
      ],
    };
    expect(triageLaneFailures(summary).map((f) => [f.checker, f.triage.class])).toEqual([
      ['tests', 'infra'],
      ['compile', 'code'],
    ]);
  });
});

describe('checkInfraParkMessage', () => {
  it('names the checker and the line', () => {
    const msg = checkInfraParkMessage('tests', 'read ECONNRESET');
    expect(msg).toContain('tests');
    expect(msg).toContain('read ECONNRESET');
  });
});
