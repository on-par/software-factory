import { describe, expect, it } from 'vitest';

import * as adapter from './index.js';

describe('index exports', () => {
  it('re-exports the adapter public API', () => {
    expect(typeof adapter.materializeBrief).toBe('function');
    expect(typeof adapter.prepareWorkspace).toBe('function');
    expect(typeof adapter.commitCheckpoint).toBe('function');
    expect(typeof adapter.buildRunBriefArgs).toBe('function');
    expect(typeof adapter.runFactory).toBe('function');
    expect(typeof adapter.collectArtifacts).toBe('function');
    expect(typeof adapter.runCheckpoint).toBe('function');
    expect(typeof adapter.createExecaExec).toBe('function');
    expect(typeof adapter.defaultCliDeps).toBe('function');
    expect(typeof adapter.runCli).toBe('function');
    expect(adapter.AdapterError).toBeInstanceOf(Function);
    expect(typeof adapter.parsePinFile).toBe('function');
    expect(typeof adapter.checkPinnedInput).toBe('function');
    expect(typeof adapter.runPinPreflight).toBe('function');
    expect(typeof adapter.runCatalogPreflight).toBe('function');
  });
});
