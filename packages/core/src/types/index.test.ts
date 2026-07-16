import { describe, expect, it } from 'vitest';
import type { CostEntry, FactoryEvent, FailoverReason } from './index.js';

// The types module is types-only by contract: its coverage exclusion in
// vitest.config.ts assumes it contains no executable statements. Type-only
// exports (type/interface) leave no runtime bindings, so any runtime export
// (const/function/class/enum) added here makes this test fail — put logic in
// a covered module instead (e.g. harness/, router/).
describe('types module', () => {
  it('stays types-only: has no runtime exports', async () => {
    const runtimeExports = Object.keys(await import('./index.js'));
    expect(runtimeExports).toEqual([]);
  });

  it('FailoverReason enumerates the issue-named reasons and round-trips on CostEntry/FactoryEvent', () => {
    const reasons: FailoverReason[] = ['rate_limit', 'usage_cap', 'timeout', 'error', 'empty_response', 'unavailable'];

    for (const failoverReason of reasons) {
      const cost: CostEntry = {
        ts: '2026-07-16T00:00:00Z',
        issue: '1',
        task: 'build',
        model: 'm',
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        failoverReason,
      };
      const event: FactoryEvent = {
        ts: '2026-07-16T00:00:00Z',
        type: 'failover',
        issue: '1',
        msg: 'm',
        failoverReason,
      };

      expect(JSON.parse(JSON.stringify(cost)).failoverReason).toBe(failoverReason);
      expect(JSON.parse(JSON.stringify(event)).failoverReason).toBe(failoverReason);
    }
  });
});
