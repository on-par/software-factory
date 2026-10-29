import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../types/index.js';
import {
  meetsWalkthroughThreshold,
  type NumstatEntry,
  parseNumstat,
  renderPrWalkthrough,
  resolveWalkthroughThresholds,
} from './pr-walkthrough.js';

const defaults = { minLines: 300, minFiles: 5 };

function entries(count: number, linesEach: number): NumstatEntry[] {
  return Array.from({ length: count }, (_, i) => ({ path: `f${i}.ts`, added: linesEach, deleted: 0 }));
}

describe('parseNumstat', () => {
  it('parses rows, treats binary and non-numeric counts as 0, and skips blank or malformed lines', () => {
    const out = parseNumstat('10\t2\tsrc/a.ts\n\n-\t-\tlogo.png\nbad line\nx\t3\tb.ts\n');
    expect(out).toEqual([
      { path: 'src/a.ts', added: 10, deleted: 2 },
      { path: 'logo.png', added: 0, deleted: 0 },
      { path: 'b.ts', added: 0, deleted: 3 },
    ]);
  });

  it('keeps a path containing a tab', () => {
    expect(parseNumstat('1\t1\ta\tb.ts')).toEqual([{ path: 'a\tb.ts', added: 1, deleted: 1 }]);
  });
});

describe('meetsWalkthroughThreshold', () => {
  it('needs both the line and the file threshold', () => {
    expect(meetsWalkthroughThreshold(entries(5, 60), defaults)).toBe(true);
    expect(meetsWalkthroughThreshold(entries(5, 59), defaults)).toBe(false);
    expect(meetsWalkthroughThreshold(entries(4, 75), defaults)).toBe(false);
  });

  it('honours custom thresholds, including zero on an empty diff', () => {
    expect(meetsWalkthroughThreshold(entries(2, 5), { minLines: 10, minFiles: 2 })).toBe(true);
    expect(meetsWalkthroughThreshold([], { minLines: 0, minFiles: 0 })).toBe(true);
  });
});

describe('resolveWalkthroughThresholds', () => {
  it('uses the defaults and keeps the other default for a partial override', () => {
    expect(resolveWalkthroughThresholds()).toEqual(defaults);
    expect(resolveWalkthroughThresholds({ minLines: 10 })).toEqual({ minLines: 10, minFiles: 5 });
  });
});

describe('renderPrWalkthrough', () => {
  it('renders Intent and How to verify with Automated and Manual subsections, and lists no files', () => {
    const checkSummary: CheckSummary = {
      passes: 3,
      failures: 1,
      skips: 2,
      total: 6,
      results: [
        {
          checker: 'evidence_plan',
          result: 'PASS',
          details: 'ok',
          evidencePlanResults: [
            { kind: 'screenshot', claim: 'Dialog looks right', status: 'PASS', reason: 'r' },
            { kind: 'fail-to-pass-test', claim: 'Unit claim', status: 'PASS', reason: 'r' },
          ],
        },
      ],
    };
    const md = renderPrWalkthrough({
      specBody: '## Goal\n\nRetry uploads.\n\n## Tests\n\n- covers retry\n',
      checkSummary,
    });

    for (const heading of ['### Intent', '### How to verify', '#### Automated', '#### Manual']) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Retry uploads.');
    expect(md).not.toContain('Main files');
    expect(md).toContain('- Checkers: 3 pass, 1 fail, 2 skip');
    expect(md).toContain('- covers retry');
    expect(md).toContain('- Dialog looks right [screenshot]');
    expect(md).not.toContain('Unit claim');
  });

  it('renders the fallbacks with no spec and no checker summary', () => {
    const md = renderPrWalkthrough({});
    expect(md).toContain('- No spec goal recorded.');
    expect(md).toContain('- Checkers: not run');
    expect(md).toContain('- None recorded.');
  });
});
