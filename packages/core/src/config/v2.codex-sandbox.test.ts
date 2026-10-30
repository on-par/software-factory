import { describe, expect, it } from 'vitest';

import { parseV2Config } from './v2.js';

describe('run.sandbox.codexSandbox (#3829)', () => {
  it('run.sandbox accepts codexSandbox and gives it no default (#3829)', () => {
    const withKey = parseV2Config({ version: 2, run: { sandbox: { codexSandbox: 'workspace-write' } } });
    expect(withKey.run.sandbox.codexSandbox).toBe('workspace-write');
    const without = parseV2Config({ version: 2, run: { sandbox: {} } });
    expect('codexSandbox' in without.run.sandbox).toBe(false);
  });
});
