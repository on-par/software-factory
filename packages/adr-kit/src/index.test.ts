import { describe, expect, it } from 'vitest';

import * as adrKit from './index.js';

describe('index barrel', () => {
  it('re-exports the public surface of all six modules', () => {
    expect(adrKit.NYGARD_CONVENTION).toBeDefined();
    expect(adrKit.createAdr).toBeTypeOf('function');
    expect(adrKit.normalizeStatus).toBeTypeOf('function');
    expect(adrKit.formatAdrNumber).toBeTypeOf('function');
    expect(adrKit.parseAdr).toBeTypeOf('function');
    expect(adrKit.serializeAdr).toBeTypeOf('function');
    expect(adrKit.parseIndexTable).toBeTypeOf('function');
    expect(adrKit.renderIndexTable).toBeTypeOf('function');
    expect(adrKit.upsertIndexRow).toBeTypeOf('function');
  });
});
