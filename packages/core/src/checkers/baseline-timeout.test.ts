import { describe, expect, it } from 'vitest';

import type { CheckerOutput } from '../types/index.js';
import { compareBaseline } from './baseline.js';

const out = (checker: string, result: CheckerOutput['result'], details = ''): CheckerOutput => ({
  checker,
  result,
  details,
});

describe('compareBaseline timeouts (#3186)', () => {
  it('sets baseTimedOut only for a timed-out base FAIL, keeping fails-on-base', () => {
    const timedOut = { ...out('compile', 'FAIL', 'timed out'), timedOut: true };
    const [slow] = compareBaseline([out('compile', 'FAIL')], [timedOut]);
    expect(slow).toMatchObject({ verdict: 'fails-on-base', baseTimedOut: true });
    const [plain] = compareBaseline([out('compile', 'FAIL')], [out('compile', 'FAIL', 'x')]);
    expect(plain.verdict).toBe('fails-on-base');
    expect(plain.baseTimedOut).toBeUndefined();
  });
});
