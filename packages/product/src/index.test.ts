// packages/product/src/index.test.ts — public surface (#469).

import { describe, expect, it } from 'vitest';

import * as api from './index.js';

describe('index', () => {
  it('re-exports the adr-home and program surface', () => {
    expect(typeof api.ADR_HOME_DIR).toBe('string');
    expect(typeof api.ADR_CONVENTION).toBe('object');
    expect(typeof api.resolveAdrHome).toBe('function');
    expect(typeof api.nextAdrFilename).toBe('function');
    expect(typeof api.listAdrFilenames).toBe('function');
    expect(typeof api.buildProgram).toBe('function');
    expect(typeof api.defaultDeps).toBe('function');
    expect(typeof api.getProductVersion).toBe('function');
    expect(typeof api.main).toBe('function');
  });
});
