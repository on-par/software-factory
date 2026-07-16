// src/utils/coverage-ratchet.ts — pure logic for detecting coverage-threshold drift

export interface CoverageMetrics {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export interface RatchetDrift {
  scope?: string;
  metric: keyof CoverageMetrics;
  measured: number;
  threshold: number;
  suggested: number;
}

export interface RatchetCheckResult {
  ok: boolean;
  drifts: RatchetDrift[];
}

export const DEFAULT_RATCHET_SLACK = 2;

const METRICS: Array<keyof CoverageMetrics> = ['lines', 'functions', 'branches', 'statements'];
const GLOBAL_SCOPE = 'global';

export function parseCoverageSummary(json: string): CoverageMetrics {
  const parsed = parseCoverageSummaryJson(json);
  const total = (parsed as { total?: unknown })?.total;
  if (total === null || typeof total !== 'object') {
    throw new Error('coverage summary is missing a "total" block');
  }

  return readCoverageMetrics(total, 'total');
}

export function parseCoverageSummaryScopes(json: string, scopes: string[]): Record<string, CoverageMetrics> {
  const parsed = parseCoverageSummaryJson(json);
  const summary = parsed as Record<string, unknown>;
  const result: Record<string, CoverageMetrics> = {};

  for (const scope of scopes) {
    if (scope === GLOBAL_SCOPE) {
      result[scope] = parseCoverageSummary(json);
      continue;
    }
    result[scope] = aggregateCoverageScope(summary, scope);
  }

  return result;
}

export function checkRatchetDrift(
  measured: CoverageMetrics,
  thresholds: CoverageMetrics,
  slack: number = DEFAULT_RATCHET_SLACK,
): RatchetCheckResult {
  const drifts: RatchetDrift[] = [];

  for (const metric of METRICS) {
    const measuredValue = measured[metric];
    const threshold = thresholds[metric];
    if (measuredValue - threshold > slack) {
      drifts.push({
        metric,
        measured: measuredValue,
        threshold,
        suggested: Math.floor(measuredValue) - 1,
      });
    }
  }

  return { ok: drifts.length === 0, drifts };
}

export function checkScopedRatchetDrift(
  measuredByScope: Record<string, CoverageMetrics>,
  thresholdsByScope: Record<string, CoverageMetrics>,
  slack: number = DEFAULT_RATCHET_SLACK,
): RatchetCheckResult {
  const drifts: RatchetDrift[] = [];

  for (const [scope, thresholds] of Object.entries(thresholdsByScope)) {
    const measured = measuredByScope[scope];
    if (!measured) {
      throw new Error(`coverage summary has no measured data for threshold scope "${scope}"`);
    }
    const scoped = checkRatchetDrift(measured, thresholds, slack);
    drifts.push(...scoped.drifts.map((drift) => (scope === GLOBAL_SCOPE ? drift : { ...drift, scope })));
  }

  return { ok: drifts.length === 0, drifts };
}

export function renderRatchetReport(result: RatchetCheckResult, slack: number): string {
  if (result.ok) {
    return `Coverage ratchet OK — all thresholds within ${slack}pts of measured coverage.`;
  }

  const hasScopes = result.drifts.some((drift) => drift.scope);
  const lines = [
    hasScopes
      ? '| Scope | Metric | Measured | Threshold | Suggested |'
      : '| Metric | Measured | Threshold | Suggested |',
    hasScopes ? '| --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- |',
    ...result.drifts.map((drift) =>
      hasScopes
        ? `| ${drift.scope ?? GLOBAL_SCOPE} | ${drift.metric} | ${drift.measured}% | ${drift.threshold}% | ${drift.suggested}% |`
        : `| ${drift.metric} | ${drift.measured}% | ${drift.threshold}% | ${drift.suggested}% |`,
    ),
    '',
    'Measured coverage has drifted more than ' +
      `${slack}pts above the committed thresholds. Raise \`thresholds\` in ` +
      'vitest.config.ts to the suggested values in this PR (the ratchet moves up, never down).',
  ];

  return lines.join('\n');
}

function parseCoverageSummaryJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (err) {
    throw new Error(`coverage summary is not valid JSON: ${(err as Error).message}`);
  }
}

function readCoverageMetrics(block: unknown, label: string): CoverageMetrics {
  const metrics = {} as CoverageMetrics;
  for (const metric of METRICS) {
    const pct = (block as Record<string, { pct?: unknown } | undefined>)[metric]?.pct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) {
      throw new Error(`coverage summary is missing a numeric ${label}.${metric}.pct`);
    }
    metrics[metric] = pct;
  }
  return metrics;
}

function aggregateCoverageScope(summary: Record<string, unknown>, scope: string): CoverageMetrics {
  const totals: Record<keyof CoverageMetrics, { total: number; covered: number }> = {
    lines: { total: 0, covered: 0 },
    functions: { total: 0, covered: 0 },
    branches: { total: 0, covered: 0 },
    statements: { total: 0, covered: 0 },
  };

  for (const [filePath, block] of Object.entries(summary)) {
    if (filePath === 'total' || !matchesCoverageScope(filePath, scope)) continue;
    for (const metric of METRICS) {
      const counts = (block as Record<string, { total?: unknown; covered?: unknown } | undefined>)[metric];
      if (!counts) continue;
      if (typeof counts.total !== 'number' || typeof counts.covered !== 'number') {
        throw new Error(`coverage summary is missing numeric counts for ${filePath}.${metric}`);
      }
      totals[metric].total += counts.total;
      totals[metric].covered += counts.covered;
    }
  }

  const metrics = {} as CoverageMetrics;
  for (const metric of METRICS) {
    if (totals[metric].total === 0) {
      throw new Error(`coverage summary has no files for threshold scope "${scope}"`);
    }
    metrics[metric] = Number(((totals[metric].covered / totals[metric].total) * 100).toFixed(2));
  }
  return metrics;
}

function matchesCoverageScope(filePath: string, scope: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const marker = '/**/*';
  const markerIndex = scope.indexOf(marker);
  if (markerIndex === -1) return normalizedPath === scope || normalizedPath.endsWith(`/${scope}`);

  const prefix = scope.slice(0, markerIndex + 1);
  const suffix = scope.slice(markerIndex + marker.length);
  if (!normalizedPath.startsWith(prefix) && !normalizedPath.includes(`/${prefix}`)) return false;

  if (suffix.startsWith('.{') && suffix.endsWith('}')) {
    const extensions = suffix
      .slice(2, -1)
      .split(',')
      .map((ext) => `.${ext}`);
    return extensions.some((extension) => normalizedPath.endsWith(extension));
  }

  return suffix === '' || normalizedPath.endsWith(suffix);
}
