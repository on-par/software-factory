// packages/scbench-adapter/src/baseline.ts — pinned SlopCodeBench baseline
// config loader + report generator (#511).
import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { BENCHMARK_MANIFEST_VERSION, type BenchmarkManifest } from '@on-par/factory-core';

import { AdapterError } from './checkpoint.js';

export interface BaselineConfig {
  baselineId: string;
  factory: { repo: string; commit: string; packageVersion: string };
  scbench: { repo: string; commit: string; pinnedAt: string };
  modelConfig: { source: string; env: Record<string, string> };
  promptInputs: string;
  environment: { node: string; requiredBinaries: string[]; hostClass: string; scbenchHarness: string };
  problems: { selection: string; smoke: string; suite: string };
  trials: { smokeRuns: number; suiteTrialsPerProblem: number };
  comparisonThreshold: number;
}

const REQUIRED_KEYS = [
  'baselineId',
  'factory',
  'scbench',
  'modelConfig',
  'promptInputs',
  'environment',
  'problems',
  'trials',
  'comparisonThreshold',
] as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** Parse + structurally validate a baseline config: every required
 *  top-level field present, a positive comparisonThreshold, and
 *  full-length git SHAs for factory.commit/scbench.commit. Throws
 *  AdapterError naming the offending field. */
export function loadBaselineConfig(raw: string): BaselineConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AdapterError(`could not parse baseline config: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AdapterError('baseline config must be a JSON object');
  }
  const config = parsed as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in config)) {
      throw new AdapterError(`baseline config missing required field "${key}"`);
    }
  }
  if (typeof config.comparisonThreshold !== 'number' || config.comparisonThreshold <= 0) {
    throw new AdapterError('baseline config field "comparisonThreshold" must be a positive number');
  }

  const factory = config.factory as { commit?: unknown } | null;
  if (typeof factory?.commit !== 'string' || !FULL_SHA_RE.test(factory.commit)) {
    throw new AdapterError('baseline config field "factory.commit" must be a full-length (40 hex char) git SHA');
  }
  const scbench = config.scbench as { commit?: unknown } | null;
  if (typeof scbench?.commit !== 'string' || !FULL_SHA_RE.test(scbench.commit)) {
    throw new AdapterError('baseline config field "scbench.commit" must be a full-length (40 hex char) git SHA');
  }

  return config as unknown as BaselineConfig;
}

export interface BaselineTrial {
  /** Manifest's directory path, relative to the runs root (e.g. "smoke/trial-1"). */
  id: string;
  manifestPath: string;
  manifest: BenchmarkManifest;
}

export interface BaselineFsDeps {
  readdirSync: (dir: string) => Dirent[];
  readFileSync: (path: string) => string;
}

const REAL_FS: BaselineFsDeps = {
  readdirSync: (dir) => readdirSync(dir, { withFileTypes: true }),
  readFileSync: (path) => readFileSync(path, 'utf-8'),
};

function findManifestPaths(dir: string, deps: BaselineFsDeps): string[] {
  const found: string[] = [];
  for (const entry of deps.readdirSync(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findManifestPaths(full, deps));
    } else if (entry.name === 'manifest.json') {
      found.push(full);
    }
  }
  return found;
}

function toTrialId(runsDir: string, manifestPath: string): string {
  return relative(runsDir, dirname(manifestPath)).split(sep).join('/');
}

/** Recursively scan `runsDir` for manifest.json files, validate each against
 *  BENCHMARK_MANIFEST_VERSION, and return them sorted by trial id for
 *  deterministic report output. An empty (or nonexistent-content) directory
 *  is valid — the caller renders "no trials" rather than failing. */
export function collectBaselineTrials(runsDir: string, deps: BaselineFsDeps = REAL_FS): BaselineTrial[] {
  const trials = findManifestPaths(runsDir, deps).map((manifestPath) => {
    let manifest: BenchmarkManifest;
    try {
      manifest = JSON.parse(deps.readFileSync(manifestPath)) as BenchmarkManifest;
    } catch (err) {
      throw new AdapterError(`could not parse ${manifestPath}: ${(err as Error).message}`);
    }
    if (manifest.manifestVersion !== BENCHMARK_MANIFEST_VERSION) {
      throw new AdapterError(
        `manifest version mismatch at ${manifestPath}: expected ${BENCHMARK_MANIFEST_VERSION}, got ${manifest.manifestVersion}`,
      );
    }
    return { id: toTrialId(runsDir, manifestPath), manifestPath, manifest };
  });
  trials.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return trials;
}

function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function formatPassRate(ready: number, total: number): string {
  if (total === 0) return 'no trials recorded';
  return `${ready}/${total} (${((ready / total) * 100).toFixed(1)}%)`;
}

function renderPinnedInputs(config: BaselineConfig): string {
  return [
    `- Factory: \`${config.factory.repo}\` @ \`${config.factory.commit}\` (package v${config.factory.packageVersion})`,
    `- SlopCodeBench: \`${config.scbench.repo}\` @ \`${config.scbench.commit}\` (pinned ${config.scbench.pinnedAt})`,
    `- Model config: ${config.modelConfig.source}; env: ${formatEnv(config.modelConfig.env)}`,
    `- Prompt inputs: ${config.promptInputs}`,
    `- Environment: node ${config.environment.node}; binaries: ${config.environment.requiredBinaries.join(', ')}; host: ${config.environment.hostClass}; harness: ${config.environment.scbenchHarness}`,
    `- Problem selection: ${config.problems.selection}; smoke: ${config.problems.smoke}; suite: ${config.problems.suite}`,
    `- Trial plan: ${config.trials.smokeRuns} smoke run(s), ${config.trials.suiteTrialsPerProblem} suite trial(s) per problem`,
  ].join('\n');
}

function renderTrials(trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'No trials recorded.';
  return trials
    .map(
      (t) =>
        `- \`${t.id}\`: outcome \`${t.manifest.run.outcome}\`, elapsed ${t.manifest.run.elapsedMs}ms, manifest \`${t.manifestPath}\``,
    )
    .join('\n');
}

function renderPassRate(trials: BaselineTrial[]): string {
  const ready = trials.filter((t) => t.manifest.run.outcome === 'ready').length;
  return formatPassRate(ready, trials.length);
}

function problemGroupOf(trialId: string): string | undefined {
  const parts = trialId.split('/');
  return parts.length >= 3 ? parts[1] : undefined;
}

function renderErosion(trials: BaselineTrial[]): string {
  const groups = new Map<string, BaselineTrial[]>();
  for (const trial of trials) {
    const problem = problemGroupOf(trial.id);
    if (problem === undefined) continue;
    const list = groups.get(problem) ?? [];
    list.push(trial);
    groups.set(problem, list);
  }
  if (groups.size === 0) {
    return 'Not yet measurable — requires the live multi-checkpoint suite run.';
  }
  return [...groups.keys()]
    .sort()
    .map((problem) => {
      const outcomes = groups
        .get(problem)!
        .map((t) => `\`${t.id}\`: ${t.manifest.run.outcome}`)
        .join(', ');
      return `- ${problem}: ${outcomes}`;
    })
    .join('\n');
}

function renderElapsed(trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'No trials recorded.';
  const total = trials.reduce((sum, t) => sum + t.manifest.run.elapsedMs, 0);
  const mean = total / trials.length;
  return `Total elapsed: ${total}ms across ${trials.length} trial(s); mean ${mean.toFixed(1)}ms.`;
}

function renderCost(trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'No trials recorded.';
  const totals = trials.reduce(
    (acc, t) => ({
      totalUsd: acc.totalUsd + t.manifest.cost.totalUsd,
      inputTokens: acc.inputTokens + t.manifest.cost.inputTokens,
      outputTokens: acc.outputTokens + t.manifest.cost.outputTokens,
    }),
    { totalUsd: 0, inputTokens: 0, outputTokens: 0 },
  );
  return `Total cost: $${totals.totalUsd.toFixed(4)}; input tokens: ${totals.inputTokens}; output tokens: ${totals.outputTokens}.`;
}

function renderRouting(trials: BaselineTrial[]): string {
  const attempts = trials.flatMap((t) => t.manifest.modelAttempts);
  if (attempts.length === 0) return 'No routing or failover events recorded.';
  const byKey = new Map<string, { count: number; reasons: Set<string> }>();
  for (const attempt of attempts) {
    const key = `${attempt.model} / ${attempt.task}`;
    const entry = byKey.get(key) ?? { count: 0, reasons: new Set<string>() };
    entry.count += 1;
    if (attempt.reason) entry.reasons.add(attempt.reason);
    byKey.set(key, entry);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => {
      const reasons = entry.reasons.size > 0 ? `; failover reasons: ${[...entry.reasons].sort().join(', ')}` : '';
      return `- ${key}: ${entry.count} attempt(s)${reasons}`;
    })
    .join('\n');
}

function renderCheckerOutcomes(trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'No trials recorded.';
  return trials
    .map((t) => {
      const checker = t.manifest.checker;
      if (!checker) return `- \`${t.id}\`: No checker data (run ended before CHECK or checker summary absent).`;
      return `- \`${t.id}\`: ${checker.passes} passed, ${checker.failures} failed, ${checker.skips} skipped (total ${checker.total}).`;
    })
    .join('\n');
}

function renderFailureNotes(trials: BaselineTrial[]): string {
  const withFailures = trials.filter((t) => t.manifest.failure);
  if (withFailures.length === 0) return 'No failures recorded.';
  return withFailures
    .map((t) => {
      const failure = t.manifest.failure!;
      return `- \`${t.id}\`: phase \`${failure.phase}\`, reason \`${failure.reason}\` — ${failure.message}`;
    })
    .join('\n');
}

/** Pure string builder — every rendered value is derived from `config` and
 *  `trials[].manifest`, never from wall-clock state or transcribed logs. */
export function generateBaselineReport(config: BaselineConfig, trials: BaselineTrial[]): string {
  const statusLines = [`**Trial count:** ${trials.length} (comparison threshold: ${config.comparisonThreshold})`];
  if (trials.length < config.comparisonThreshold) {
    statusLines.push(
      `**Status: PRELIMINARY** — only ${trials.length} of the required ${config.comparisonThreshold} trials per configuration have been recorded. Configuration scope: baseline \`${config.baselineId}\`, factory commit \`${config.factory.commit}\`, scbench commit \`${config.scbench.commit}\`, model config env: ${formatEnv(config.modelConfig.env)}.`,
    );
  } else {
    statusLines.push('**Status: comparison-ready** — the trial count meets the comparison threshold.');
  }

  const sections = [
    `# SlopCodeBench Baseline: ${config.baselineId}`,
    statusLines.join('\n\n'),
    ['## Pinned inputs', '', renderPinnedInputs(config)].join('\n'),
    ['## Trials', '', renderTrials(trials)].join('\n'),
    ['## Checkpoint pass rate', '', renderPassRate(trials)].join('\n'),
    ['## Erosion trajectory', '', renderErosion(trials)].join('\n'),
    ['## Elapsed time', '', renderElapsed(trials)].join('\n'),
    ['## Cost', '', renderCost(trials)].join('\n'),
    ['## Routing and failover', '', renderRouting(trials)].join('\n'),
    ['## Checker outcomes', '', renderCheckerOutcomes(trials)].join('\n'),
    ['## Failure notes', '', renderFailureNotes(trials)].join('\n'),
    [
      '## Reproduction',
      '',
      'See `evals/scbench-baseline/README.md` for the exact commands to reproduce the live smoke and small-suite runs and to regenerate this report. Every number above is derived from the trial manifests listed in the Trials section — none is hand-transcribed.',
    ].join('\n'),
  ];

  return `${sections.join('\n\n')}\n`;
}
