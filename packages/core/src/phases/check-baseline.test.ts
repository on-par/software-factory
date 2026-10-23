import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { BaselineReport } from '../checkers/baseline.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { ModelRouter } from '../router/index.js';
import { baselineCacheOptions, describeBaseline } from './check-baseline.js';
import { checkPhase } from './check.js';

const tempDirs = createTempDirs();
afterEach(() => tempDirs.cleanup());

describe('baselineCacheOptions (#3540)', () => {
  const verdict = async () => ({ green: true, reason: 'ok' });

  it('has no cache without a path and forwards the verdict and hook', () => {
    const hook = () => {};
    const o = baselineCacheOptions(undefined, 6, verdict, hook);
    expect(o).toEqual({ cache: undefined, requiredChecksVerdict: verdict, onCacheInvalidated: hook });
  });

  it('builds a cache when a path is given', () => {
    expect(baselineCacheOptions('/tmp/c.json', 6, undefined, () => {}).cache).toBeDefined();
  });
});

describe('describeBaseline', () => {
  it('summarises each verdict', () => {
    const report: BaselineReport = {
      baseSha: 'abcdef1234567890',
      checkers: [
        { checker: 'tests', verdict: 'fails-on-base', cached: true },
        { checker: 'lint', verdict: 'clean-on-base' },
        { checker: 'compile', verdict: 'not-run', reason: 'skipped' },
      ],
    };
    expect(describeBaseline(report)).toBe(
      'baseline at abcdef12: tests also fails on base (cached); lint clean on base; compile not run on base (skipped)',
    );
  });
});

describe('checkPhase baseline cache wiring (#3540)', () => {
  it('forwards requiredChecksVerdict to runBaseline and logs baseline-cache-invalidated', async () => {
    const worktree = await tempDirs.make('check-baseline-3540-');
    await writeFile(join(worktree, 'package.json'), JSON.stringify({ scripts: { test: 'exit 1' } }));
    await writeFile(join(worktree, 'issue-77.md'), '# Spec: failing checks\n');
    const logs: Array<[string, string]> = [];
    const requiredChecksVerdict = async () => ({ green: true, reason: 'ok' });
    let forwarded: unknown;
    await checkPhase({
      issue: 77,
      worktree,
      specPath: join(worktree, 'issue-77.md'),
      router: {} as ModelRouter,
      constitution: null,
      maxReworkRounds: 0,
      diffBase: 'abc1234567',
      requiredChecksVerdict,
      log: (type, msg) => logs.push([type, msg]),
      runBaseline: async (o) => {
        forwarded = o.requiredChecksVerdict;
        o.onCacheInvalidated?.('tests', 'r');
        return { baseSha: o.baseSha, checkers: [] };
      },
    });
    expect(forwarded).toBe(requiredChecksVerdict);
    expect(logs).toContainEqual(['baseline-cache-invalidated', 'baseline cache invalidated: abc1234567 tests — r']);
  });
});
