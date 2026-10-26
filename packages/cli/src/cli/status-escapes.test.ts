// packages/cli/src/cli/status-escapes.test.ts — `factory status` Last Events strips terminal escapes (#1634)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { installShipHarness, logged, paths, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

describe('cli status', () => {
  it('status Last Events strips terminal escapes from event text (#1634)', async () => {
    mkdirSync(dirname(paths().events), { recursive: true });
    writeFileSync(
      paths().events,
      JSON.stringify({ type: 'plan', issue: '7', msg: 'title \x1b]0;pwned\x07 end' }) + '\n',
    );
    await runMainWith(undefined, 'status');
    const out = logged();
    expect(out).toContain('title ]0;pwned end');
    expect(out).not.toContain('\x1b]0;');
    expect(out).not.toContain('\x07');
  });
});
