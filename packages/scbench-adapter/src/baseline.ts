// packages/scbench-adapter/src/baseline.ts — pinned SlopCodeBench baseline
// config loader + report generator (#511).
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { BENCHMARK_MANIFEST_VERSION, type BenchmarkManifest } from '@on-par/factory-core';

import { NATIVE_EVIDENCE_FILES } from './artifacts.js';
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
  passPolicy: { id: 'core-cases'; description: string };
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
  'passPolicy',
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

  const passPolicy = config.passPolicy as { id?: unknown; description?: unknown } | null;
  if (typeof passPolicy !== 'object' || passPolicy === null || passPolicy.id !== 'core-cases') {
    throw new AdapterError('baseline config field "passPolicy.id" must be "core-cases" — the only pinned pass policy');
  }
  if (typeof passPolicy.description !== 'string' || passPolicy.description.length === 0) {
    throw new AdapterError('baseline config field "passPolicy.description" must be a non-empty string');
  }

  return config as unknown as BaselineConfig;
}

/** Parsed subset of SCBench's native per-checkpoint evaluation.json
 *  (CorrectnessResults at the pinned commit). Extra fields are ignored. */
export interface ScbenchEvaluation {
  problem_name: string;
  checkpoint_name: string;
  pass_counts: Record<string, number>;
  total_counts: Record<string, number>;
  pytest_exit_code: number;
  infrastructure_failure: boolean;
}

/** One line of SCBench's run-level checkpoint_results.jsonl. Extra fields
 *  are ignored. */
export interface ScbenchRunRecord {
  problem: string;
  checkpoint: string;
  state: string;
  core_passed: number;
  core_total: number;
}

/** Native SCBench evidence found colocated with a trial's manifest.json. */
export interface BaselineTrialEvidence {
  evaluation?: ScbenchEvaluation;
  runRecords?: ScbenchRunRecord[];
  runInfoPresent: boolean;
}

export type TrialVerdict = 'pass' | 'fail' | 'infrastructure-failure' | 'missing-evidence';

export interface BaselineTrial {
  /** Manifest's directory path, relative to the runs root (e.g. "smoke/trial-1"). */
  id: string;
  manifestPath: string;
  manifest: BenchmarkManifest;
  evidence: BaselineTrialEvidence;
}

export interface BaselineFsDeps {
  existsSync: (path: string) => boolean;
  readdirSync: (dir: string) => Dirent[];
  readFileSync: (path: string) => string;
}

const REAL_FS: BaselineFsDeps = {
  existsSync,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  return isPlainObject(value) && Object.values(value).every((v) => typeof v === 'number');
}

/** Parse + structurally validate a single trial's native evaluation.json.
 *  Throws AdapterError naming `path` and the offending field. */
function parseEvaluation(raw: string, path: string): ScbenchEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AdapterError(`could not parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new AdapterError(`invalid evaluation evidence at ${path}: must be a JSON object`);
  }
  const invalid = (field: string, expectation: string): never => {
    throw new AdapterError(`invalid evaluation evidence at ${path}: field "${field}" must be ${expectation}`);
  };
  if (typeof parsed.problem_name !== 'string' || parsed.problem_name.length === 0) {
    invalid('problem_name', 'a non-empty string');
  }
  if (typeof parsed.checkpoint_name !== 'string' || parsed.checkpoint_name.length === 0) {
    invalid('checkpoint_name', 'a non-empty string');
  }
  if (!isRecordOfNumbers(parsed.pass_counts)) {
    invalid('pass_counts', 'an object whose values are numbers');
  }
  if (!isRecordOfNumbers(parsed.total_counts)) {
    invalid('total_counts', 'an object whose values are numbers');
  }
  if (typeof parsed.pytest_exit_code !== 'number') {
    invalid('pytest_exit_code', 'a number');
  }
  if (typeof parsed.infrastructure_failure !== 'boolean') {
    invalid('infrastructure_failure', 'a boolean');
  }
  return parsed as unknown as ScbenchEvaluation;
}

/** Parse + structurally validate SCBench's run-level
 *  checkpoint_results.jsonl (one JSON object per non-blank line). Throws
 *  AdapterError naming `path` and the 1-based line number. */
function parseRunRecords(raw: string, path: string): ScbenchRunRecord[] {
  const invalid = (line: number, field: string, expectation: string): never => {
    throw new AdapterError(`invalid run record at ${path} line ${line}: field "${field}" must be ${expectation}`);
  };
  const records: ScbenchRunRecord[] = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const lineNumber = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new AdapterError(`could not parse ${path} line ${lineNumber}: ${(err as Error).message}`);
    }
    if (!isPlainObject(parsed)) {
      throw new AdapterError(`invalid run record at ${path} line ${lineNumber}: must be a JSON object`);
    }
    if (typeof parsed.problem !== 'string') invalid(lineNumber, 'problem', 'a string');
    if (typeof parsed.checkpoint !== 'string') invalid(lineNumber, 'checkpoint', 'a string');
    if (typeof parsed.state !== 'string') invalid(lineNumber, 'state', 'a string');
    if (typeof parsed.core_passed !== 'number') invalid(lineNumber, 'core_passed', 'a number');
    if (typeof parsed.core_total !== 'number') invalid(lineNumber, 'core_total', 'a number');
    records.push(parsed as unknown as ScbenchRunRecord);
  }
  return records;
}

/** Load the native SCBench evidence colocated with a trial's manifest.json,
 *  if present. SCBench writes this evidence after the adapter returns, so
 *  the adapter never produces it — retention is an operator copy step
 *  (see evals/scbench-baseline/README.md). */
function loadEvidence(dir: string, deps: BaselineFsDeps): BaselineTrialEvidence {
  const [evaluationFile, runRecordsFile, runInfoFile] = NATIVE_EVIDENCE_FILES;
  const evaluationPath = join(dir, evaluationFile);
  const runRecordsPath = join(dir, runRecordsFile);
  const runInfoPath = join(dir, runInfoFile);

  const evaluation = deps.existsSync(evaluationPath)
    ? parseEvaluation(deps.readFileSync(evaluationPath), evaluationPath)
    : undefined;
  const runRecords = deps.existsSync(runRecordsPath)
    ? parseRunRecords(deps.readFileSync(runRecordsPath), runRecordsPath)
    : undefined;
  const runInfoPresent = deps.existsSync(runInfoPath);

  return { evaluation, runRecords, runInfoPresent };
}

/** Recursively scan `runsDir` for manifest.json files, validate each against
 *  BENCHMARK_MANIFEST_VERSION, and return them sorted by trial id for
 *  deterministic report output. An empty (but existing) directory is valid —
 *  the caller renders "no trials" rather than failing. A missing `runsDir`
 *  throws AdapterError instead of letting readdirSync's raw ENOENT escape. */
export function collectBaselineTrials(runsDir: string, deps: BaselineFsDeps = REAL_FS): BaselineTrial[] {
  if (!deps.existsSync(runsDir)) {
    throw new AdapterError(`no such directory: ${runsDir} — pass an existing --runs directory`);
  }

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
    const evidence = loadEvidence(dirname(manifestPath), deps);
    return { id: toTrialId(runsDir, manifestPath), manifestPath, manifest, evidence };
  });
  trials.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return trials;
}

/** Pinned pass policy 'core-cases' — mirrors upstream PassPolicy.CORE_CASES
 *  at the pinned SCBench commit (pass_counts.Core === total_counts.Core),
 *  fail-closed on missing evidence or infrastructure failure. */
export function evaluateTrialVerdict(trial: BaselineTrial): TrialVerdict {
  const evaluation = trial.evidence.evaluation;
  if (!evaluation) return 'missing-evidence';
  if (evaluation.infrastructure_failure) return 'infrastructure-failure';
  return (evaluation.pass_counts.Core ?? 0) === (evaluation.total_counts.Core ?? 0) ? 'pass' : 'fail';
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
    `- Pass policy: \`${config.passPolicy.id}\` — ${config.passPolicy.description}`,
  ].join('\n');
}

function evidencePresent(evidence: BaselineTrialEvidence): string {
  const present = [
    evidence.evaluation ? NATIVE_EVIDENCE_FILES[0] : undefined,
    evidence.runRecords ? NATIVE_EVIDENCE_FILES[1] : undefined,
    evidence.runInfoPresent ? NATIVE_EVIDENCE_FILES[2] : undefined,
  ].filter((f): f is (typeof NATIVE_EVIDENCE_FILES)[number] => f !== undefined);
  return present.length > 0 ? present.join(', ') : 'none';
}

function renderTrials(trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'No trials recorded.';
  return trials
    .map(
      (t) =>
        `- \`${t.id}\`: outcome \`${t.manifest.run.outcome}\`, elapsed ${t.manifest.run.elapsedMs}ms, manifest \`${t.manifestPath}\`, native evidence: ${evidencePresent(t.evidence)}`,
    )
    .join('\n');
}

function renderFactoryOutcomes(trials: BaselineTrial[]): string {
  const ready = trials.filter((t) => t.manifest.run.outcome === 'ready').length;
  if (trials.length === 0) return formatPassRate(ready, trials.length);
  return `${formatPassRate(ready, trials.length)} of Factory runs ended \`ready\`. This is harness health — a \`ready\` manifest means the PLAN → BUILD → CHECK pipeline completed, not that SCBench's checkpoint evaluation passed; benchmark correctness above is derived only from native SCBench evidence.`;
}

function renderBenchmarkPassRate(config: BaselineConfig, trials: BaselineTrial[]): string {
  if (trials.length === 0) return 'no trials recorded';

  const withEvidence = trials.filter((t) => t.evidence.evaluation);
  if (withEvidence.length === 0) {
    return `Not measurable — none of the ${trials.length} recorded trial(s) carries native SCBench evaluation evidence (\`evaluation.json\`). Factory run outcomes are reported separately under harness health and are never counted as benchmark passes.`;
  }

  const verdicts = trials.map((t) => ({ trial: t, verdict: evaluateTrialVerdict(t) }));
  const passes = verdicts.filter((v) => v.verdict === 'pass').length;
  const fails = verdicts.filter((v) => v.verdict === 'fail').length;
  const infra = verdicts.filter((v) => v.verdict === 'infrastructure-failure').length;
  const missing = verdicts.filter((v) => v.verdict === 'missing-evidence').length;
  const pct = ((passes / trials.length) * 100).toFixed(1);

  const lines = verdicts.map(({ trial, verdict }) => {
    const evaluation = trial.evidence.evaluation;
    if (verdict === 'pass' || verdict === 'fail') {
      const passed = evaluation!.pass_counts.Core ?? 0;
      const total = evaluation!.total_counts.Core ?? 0;
      return `- \`${trial.id}\`: ${verdict} — Core ${passed}/${total} (${evaluation!.problem_name} / ${evaluation!.checkpoint_name})`;
    }
    if (verdict === 'infrastructure-failure') {
      return `- \`${trial.id}\`: infrastructure failure — native evaluation reports infrastructure_failure`;
    }
    return `- \`${trial.id}\`: missing evidence — no evaluation.json in the trial directory`;
  });

  const headline = `${passes}/${trials.length} (${pct}%) under pass policy \`${config.passPolicy.id}\` — ${passes} pass, ${fails} fail, ${infra} infrastructure failure, ${missing} missing evidence. A trial without native evaluation evidence never counts as a pass.`;

  return [headline, '', ...lines].join('\n');
}

function checkpointSortKey(checkpointName: string): { n: number | undefined; name: string } {
  const match = /(\d+)$/.exec(checkpointName);
  return { n: match ? Number(match[1]) : undefined, name: checkpointName };
}

function renderErosion(trials: BaselineTrial[]): string {
  const withEvidence = trials.filter((t) => t.evidence.evaluation);
  if (withEvidence.length === 0) {
    return 'Not yet measurable — requires native SCBench evaluation evidence from the live multi-checkpoint suite run.';
  }

  const groups = new Map<string, BaselineTrial[]>();
  for (const trial of withEvidence) {
    const problem = trial.evidence.evaluation!.problem_name;
    const list = groups.get(problem) ?? [];
    list.push(trial);
    groups.set(problem, list);
  }

  return [...groups.keys()]
    .sort()
    .map((problem) => {
      const entries = groups
        .get(problem)!
        .slice()
        .sort((a, b) => {
          const ak = checkpointSortKey(a.evidence.evaluation!.checkpoint_name);
          const bk = checkpointSortKey(b.evidence.evaluation!.checkpoint_name);
          if (ak.n !== undefined && bk.n !== undefined) {
            if (ak.n !== bk.n) return ak.n - bk.n;
          } else if (ak.name !== bk.name) {
            return ak.name < bk.name ? -1 : 1;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((t) => {
          const evaluation = t.evidence.evaluation!;
          const verdict = evaluateTrialVerdict(t);
          const verdictLabel = verdict === 'infrastructure-failure' ? 'infrastructure failure' : verdict;
          const passed = evaluation.pass_counts.Core ?? 0;
          const total = evaluation.total_counts.Core ?? 0;
          return `${evaluation.checkpoint_name} \`${t.id}\`: ${verdictLabel} (Core ${passed}/${total})`;
        })
        .join(', ');
      return `- ${problem}: ${entries}`;
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
    ['## Benchmark pass rate (native SCBench evaluation)', '', renderBenchmarkPassRate(config, trials)].join('\n'),
    ['## Erosion trajectory (native SCBench evaluation)', '', renderErosion(trials)].join('\n'),
    ['## Factory run outcomes (harness health)', '', renderFactoryOutcomes(trials)].join('\n'),
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
