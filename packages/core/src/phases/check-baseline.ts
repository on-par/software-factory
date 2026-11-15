import { BaselineCache } from '../checkers/baseline-cache.js';
import type { BaselineOptions, BaselineReport } from '../checkers/baseline.js';
import type { RequiredChecksVerdict } from '../utils/required-checks.js';

export function baselineCacheOptions(
  cachePath: string | undefined,
  ttlHours: number | undefined,
  requiredChecksVerdict: ((sha: string) => Promise<RequiredChecksVerdict>) | undefined,
  onCacheInvalidated: (checker: string, reason: string) => void,
): Pick<BaselineOptions, 'cache' | 'requiredChecksVerdict' | 'onCacheInvalidated'> {
  return {
    cache: cachePath === undefined ? undefined : new BaselineCache(cachePath, undefined, ttlHours),
    requiredChecksVerdict,
    onCacheInvalidated,
  };
}

export function describeBaseline(report: BaselineReport): string {
  const parts = report.checkers.map((c) => {
    if (c.verdict === 'fails-on-base') {
      const counts =
        c.sharedFailingTests && c.newFailingTests
          ? ` (${c.sharedFailingTests.length} shared, ${c.newFailingTests.length} new failing tests)`
          : '';
      return `${c.checker} also fails on base${counts}${c.cached ? ' (cached)' : ''}`;
    }
    if (c.verdict === 'clean-on-base') return `${c.checker} clean on base${c.cached ? ' (cached)' : ''}`;
    return `${c.checker} not run on base (${c.reason ?? 'unknown'})`;
  });
  const body = parts.length > 0 ? parts.join('; ') : 'no checkers compared';
  return `baseline at ${report.baseSha.slice(0, 8)}: ${body}${report.error ? ` — error: ${report.error}` : ''}`;
}
