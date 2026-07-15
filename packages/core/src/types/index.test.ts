import { describe, expect, it } from 'vitest';

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
});
