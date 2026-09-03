// packages/scbench-adapter/src/baseline.ts — pinned SlopCodeBench baseline
// config loader + report generator (#511, #1163).
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { BENCHMARK_MANIFEST_VERSION, type BenchmarkManifest } from '@on-par/factory-core';
import { z } from 'zod';

import { NATIVE_EVIDENCE_FILES } from './artifacts.js';
import { AdapterError } from './checkpoint.js';

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const PROBLEM_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

const SHA_EXPECTATION = 'a full-length (40 hex char) git SHA';
const PROBLEM_ID_EXPECTATION = 'an exact problem id from the pinned catalog (a selection rule is not reproducible)';
const SUITE_EXPECTATION = 'a non-empty array of unique exact problem ids from the pinned catalog';
const MODEL_SOURCE_EXPECTATION =
  'a source that does not reference the deleted models.json/routes.json (model and route defaults live in packages/config/src/defaults.ts)';
const APPROVED_MODELS_EXPECTATION = 'a non-empty array of unique model ids';
const DISABLED_PROVIDERS_EXPECTATION = 'a non-empty array of provider names';

/** A required, non-empty string. The same expectation is used for the
 *  missing/wrong-type case and the empty-string case so the rendered
 *  AdapterError message never depends on which one fired. */
function nonEmptyString(expectation = 'a non-empty string') {
  return z.string(expectation).min(1, expectation);
}

function fullSha() {
  return z.string(SHA_EXPECTATION).regex(FULL_SHA_RE, SHA_EXPECTATION);
}

function problemId(expectation: string) {
  return z.string(expectation).regex(PROBLEM_ID_RE, expectation);
}

/** Single source of truth for a pinned SlopCodeBench baseline config: the
 *  `BaselineConfig` type below is inferred from it, so the declared shape and
 *  the validation cannot drift (#793). Key order matters — zod reports issues
 *  in shape order and `loadBaselineConfig` renders the first one, so this
 *  mirrors the field order of the committed baseline.config.json. */
export const BaselineConfigSchema = z.object({
  baselineId: nonEmptyString(),
  factory: z.object({ repo: nonEmptyString(), commit: fullSha(), packageVersion: nonEmptyString() }, 'an object'),
  scbench: z.object({ repo: nonEmptyString(), commit: fullSha(), pinnedAt: nonEmptyString() }, 'an object'),
  problemCatalog: z.object(
    { repo: nonEmptyString(), version: nonEmptyString(), commit: fullSha(), pinnedAt: nonEmptyString() },
    'an object',
  ),
  modelConfig: z.object(
    {
      source: nonEmptyString(MODEL_SOURCE_EXPECTATION).refine(
        (s) => !/models\.json|routes\.json/.test(s),
        MODEL_SOURCE_EXPECTATION,
      ),
      env: z.record(z.string(), z.string(), 'an object of string values'),
    },
    'an object',
  ),
  providerPolicy: z.object(
    {
      approvedModels: z
        .array(nonEmptyString(APPROVED_MODELS_EXPECTATION), APPROVED_MODELS_EXPECTATION)
        .min(1, APPROVED_MODELS_EXPECTATION)
        .refine((ids) => new Set(ids).size === ids.length, APPROVED_MODELS_EXPECTATION),
      disabledProviders: z
        .array(nonEmptyString(DISABLED_PROVIDERS_EXPECTATION), DISABLED_PROVIDERS_EXPECTATION)
        .min(1, DISABLED_PROVIDERS_EXPECTATION),
    },
    'an object',
  ),
  promptInputs: nonEmptyString(),
  environment: z.object(
    {
      node: nonEmptyString(),
      requiredBinaries: z.array(nonEmptyString(), 'an array of non-empty strings'),
      hostClass: nonEmptyString(),
      scbenchHarness: nonEmptyString(),
    },
    'an object',
  ),
  problems: z.object(
    {
      resolvedFrom: nonEmptyString(),
      smoke: problemId(PROBLEM_ID_EXPECTATION),
      suite: z
        .array(problemId(SUITE_EXPECTATION), SUITE_EXPECTATION)
        .min(1, SUITE_EXPECTATION)
        .refine((ids) => new Set(ids).size === ids.length, SUITE_EXPECTATION),
    },
    'an object',
  ),
  trials: z.object(
    {
      smokeRuns: z.int('a positive integer').positive('a positive integer'),
      suiteTrialsPerProblem: z.int('a positive integer').positive('a positive integer'),
    },
    'an object',
  ),
  comparisonThreshold: z.number('a positive number').positive('a positive number'),
  passPolicy: z.object(
    {
      id: z.literal('core-cases', '"core-cases" — the only pinned pass policy'),
      description: nonEmptyString(),
    },
    'an object',
  ),
});

/** The declared shape of a pinned baseline config, derived from — never
 *  declared alongside — `BaselineConfigSchema`. */
export type BaselineConfig = z.infer<typeof BaselineConfigSchema>;

/** Render one zod issue as the AdapterError message this loader has always
 *  thrown. An absent top-level key keeps the "missing required field" wording;
 *  everything else names the dotted path and the expectation string carried on
 *  the schema node. The issue is typed structurally so this does not depend on
 *  zod's exported issue-type name. */
function describeConfigIssue(issue: { path: PropertyKey[]; message: string }, config: Record<string, unknown>): string {
  const path = issue.path.join('.');
  if (issue.path.length === 1 && !(String(issue.path[0]) in config)) {
    return `baseline config missing required field "${path}"`;
  }
  return `baseline config field "${path}" must be ${issue.message}`;
}

/** Parse + validate a baseline config against `BaselineConfigSchema`, the single
 *  source of truth for its shape. Throws AdapterError naming the first offending
 *  field. */
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

  const result = BaselineConfigSchema.safeParse(config);
  if (!result.success) {
    throw new AdapterError(describeConfigIssue(result.error.issues[0], config));
  }
  return result.data;
}

/** One group's test outcomes inside evaluation.json's native `tests` map. */
export interface ScbenchTestGroup {
  passed: string[];
  failed: string[];
  skipped: string[];
}

/** Parsed subset of SCBench's native per-checkpoint evaluation.json
 *  (CorrectnessResults at the pinned commit). Extra fields are ignored.
 *  `tests`/`stdout`/`stderr` are optional: real retained evidence at the
 *  pinned commit carries `tests` but not stdout/stderr, and older synthetic
 *  fixtures may carry none of the three — all keep parsing (#1163). */
export interface ScbenchEvaluation {
  problem_name: string;
  checkpoint_name: string;
  pass_counts: Record<string, number>;
  total_counts: Record<string, number>;
  pytest_exit_code: number;
  infrastructure_failure: boolean;
  tests?: Record<string, ScbenchTestGroup>;
  stdout?: string;
  stderr?: string;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isTestGroupMap(value: unknown): value is Record<string, ScbenchTestGroup> {
  return (
    isPlainObject(value) &&
    Object.values(value).every(
      (group) =>
        isPlainObject(group) &&
        isStringArray(group.passed) &&
        isStringArray(group.failed) &&
        isStringArray(group.skipped),
    )
  );
}

/** Parse + structurally validate a single trial's native evaluation.json.
 *  Throws AdapterError naming `path` and the offending field. */
export function parseEvaluation(raw: string, path: string): ScbenchEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new AdapterError(`could not parse ${path}: ${(err as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new AdapterError(`invalid evaluation evidence at ${path}: must be a JSON object`);
  }
  const invalid = (field: string, expectation: string): AdapterError =>
    new AdapterError(`invalid evaluation evidence at ${path}: field "${field}" must be ${expectation}`);
  const { problem_name, checkpoint_name, pass_counts, total_counts, pytest_exit_code, infrastructure_failure } = parsed;
  const { tests, stdout, stderr } = parsed;
  if (typeof problem_name !== 'string' || problem_name.length === 0) {
    throw invalid('problem_name', 'a non-empty string');
  }
  if (typeof checkpoint_name !== 'string' || checkpoint_name.length === 0) {
    throw invalid('checkpoint_name', 'a non-empty string');
  }
  if (!isRecordOfNumbers(pass_counts)) {
    throw invalid('pass_counts', 'an object whose values are numbers');
  }
  if (!isRecordOfNumbers(total_counts)) {
    throw invalid('total_counts', 'an object whose values are numbers');
  }
  if (typeof pytest_exit_code !== 'number') {
    throw invalid('pytest_exit_code', 'a number');
  }
  if (typeof infrastructure_failure !== 'boolean') {
    throw invalid('infrastructure_failure', 'a boolean');
  }
  if (tests !== undefined && !isTestGroupMap(tests)) {
    throw invalid('tests', 'an object of {passed, failed, skipped} string arrays');
  }
  if (stdout !== undefined && typeof stdout !== 'string') {
    throw invalid('stdout', 'a string');
  }
  if (stderr !== undefined && typeof stderr !== 'string') {
    throw invalid('stderr', 'a string');
  }
  const evaluation: ScbenchEvaluation = {
    problem_name,
    checkpoint_name,
    pass_counts,
    total_counts,
    pytest_exit_code,
    infrastructure_failure,
  };
  // Assign — never spread-with-undefined — so absent optional fields do not
  // appear as `undefined` keys on the parsed evidence.
  if (tests !== undefined) evaluation.tests = tests;
  if (stdout !== undefined) evaluation.stdout = stdout;
  if (stderr !== undefined) evaluation.stderr = stderr;
  return evaluation;
}

/** Parse + structurally validate SCBench's run-level
 *  checkpoint_results.jsonl (one JSON object per non-blank line). Throws
 *  AdapterError naming `path` and the 1-based line number. */
function parseRunRecords(raw: string, path: string): ScbenchRunRecord[] {
  const invalid = (line: number, field: string, expectation: string): AdapterError =>
    new AdapterError(`invalid run record at ${path} line ${line}: field "${field}" must be ${expectation}`);
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
    const { problem, checkpoint, state, core_passed, core_total } = parsed;
    if (typeof problem !== 'string') throw invalid(lineNumber, 'problem', 'a string');
    if (typeof checkpoint !== 'string') throw invalid(lineNumber, 'checkpoint', 'a string');
    if (typeof state !== 'string') throw invalid(lineNumber, 'state', 'a string');
    if (typeof core_passed !== 'number') throw invalid(lineNumber, 'core_passed', 'a number');
    if (typeof core_total !== 'number') throw invalid(lineNumber, 'core_total', 'a number');
    records.push({ problem, checkpoint, state, core_passed, core_total });
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

/** Pass/total for one named group, defaulting an absent key to 0 (vacuous
 *  0/0 counts as equal, matching upstream's PassPolicy.CORE_CASES). Single
 *  source of truth so every render of a group's counts agrees. */
function groupCounts(evaluation: ScbenchEvaluation, group: string): { passed: number; total: number } {
  return { passed: evaluation.pass_counts[group] ?? 0, total: evaluation.total_counts[group] ?? 0 };
}

function coreCounts(evaluation: ScbenchEvaluation): { passed: number; total: number } {
  return groupCounts(evaluation, 'Core');
}

/** Fixed, deterministic render order for SCBench's four native test groups
 *  (#1255). A group whose total is 0 renders as 'none' rather than a
 *  fraction or 100%, since 0/0 is a vacuous pass, not a measured result. */
const REPORT_GROUPS = ['Core', 'Functionality', 'Regression', 'Error'] as const;

function renderGroupCounts(evaluation: ScbenchEvaluation): string {
  return REPORT_GROUPS.map((group) => {
    const { passed, total } = groupCounts(evaluation, group);
    return total === 0 ? `${group} none` : `${group} ${passed}/${total}`;
  }).join(', ');
}

/** Pinned pass policy 'core-cases' — mirrors upstream PassPolicy.CORE_CASES
 *  at the pinned SCBench commit (pass_counts.Core === total_counts.Core),
 *  fail-closed on missing evidence or infrastructure failure. */
export function evaluateTrialVerdict(trial: BaselineTrial): TrialVerdict {
  const evaluation = trial.evidence.evaluation;
  if (!evaluation) return 'missing-evidence';
  if (evaluation.infrastructure_failure) return 'infrastructure-failure';
  const { passed, total } = coreCounts(evaluation);
  return passed === total ? 'pass' : 'fail';
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
    `- Problem catalog: \`${config.problemCatalog.repo}\` @ \`${config.problemCatalog.commit}\` (release ${config.problemCatalog.version}, pinned ${config.problemCatalog.pinnedAt}) — every run sets SCBENCH_PROBLEMS_PATH to a checkout of this revision`,
    `- Problems: smoke \`${config.problems.smoke}\`; suite ${config.problems.suite.map((p) => `\`${p}\``).join(', ')} (${config.problems.resolvedFrom})`,
    `- Trial plan: ${config.trials.smokeRuns} smoke run(s), ${config.trials.suiteTrialsPerProblem} suite trial(s) per problem`,
    `- Pass policy: \`${config.passPolicy.id}\` — ${config.passPolicy.description}`,
  ].join('\n');
}

function hasEvaluation(
  t: BaselineTrial,
): t is BaselineTrial & { evidence: BaselineTrialEvidence & { evaluation: ScbenchEvaluation } } {
  return t.evidence.evaluation !== undefined;
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

  const withEvidence = trials.filter(hasEvaluation);
  if (withEvidence.length === 0) {
    return `Not measurable — none of the ${trials.length} recorded trial(s) carries native SCBench evaluation evidence (\`evaluation.json\`). Factory run outcomes are reported separately under harness health and are never counted as benchmark passes.`;
  }

  const verdicts = trials.map((t) => ({ trial: t, verdict: evaluateTrialVerdict(t) }));
  const passes = verdicts.filter((v) => v.verdict === 'pass').length;
  const fails = verdicts.filter((v) => v.verdict === 'fail').length;
  const infra = verdicts.filter((v) => v.verdict === 'infrastructure-failure').length;
  const missing = verdicts.filter((v) => v.verdict === 'missing-evidence').length;

  const lines = verdicts.map(({ trial, verdict }) => {
    if ((verdict === 'pass' || verdict === 'fail') && hasEvaluation(trial)) {
      const evaluation = trial.evidence.evaluation;
      return `- \`${trial.id}\`: ${verdict} — ${renderGroupCounts(evaluation)} (${evaluation.problem_name} / ${evaluation.checkpoint_name})`;
    }
    if (verdict === 'infrastructure-failure') {
      return `- \`${trial.id}\`: infrastructure failure — native evaluation reports infrastructure_failure`;
    }
    return `- \`${trial.id}\`: missing evidence — no evaluation.json in the trial directory`;
  });

  const headline = `${formatPassRate(passes, trials.length)} under pass policy \`${config.passPolicy.id}\` — ${passes} pass, ${fails} fail, ${infra} infrastructure failure, ${missing} missing evidence. A trial without native evaluation evidence never counts as a pass.`;

  return [headline, '', ...lines].join('\n');
}

function checkpointSortKey(checkpointName: string): { n: number | undefined; name: string } {
  const match = /(\d+)$/.exec(checkpointName);
  return { n: match ? Number(match[1]) : undefined, name: checkpointName };
}

function renderErosion(trials: BaselineTrial[]): string {
  const withEvidence = trials.filter(hasEvaluation);
  if (withEvidence.length === 0) {
    return 'Not yet measurable — requires native SCBench evaluation evidence from the live multi-checkpoint suite run.';
  }

  const groups = new Map<string, (typeof withEvidence)[number][]>();
  for (const trial of withEvidence) {
    const problem = trial.evidence.evaluation.problem_name;
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
          const ak = checkpointSortKey(a.evidence.evaluation.checkpoint_name);
          const bk = checkpointSortKey(b.evidence.evaluation.checkpoint_name);
          if (ak.n !== undefined && bk.n !== undefined) {
            if (ak.n !== bk.n) return ak.n - bk.n;
          } else if (ak.name !== bk.name) {
            return ak.name < bk.name ? -1 : 1;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((t) => {
          const evaluation = t.evidence.evaluation;
          const verdict = evaluateTrialVerdict(t);
          const verdictLabel = verdict === 'infrastructure-failure' ? 'infrastructure failure' : verdict;
          const { passed, total } = coreCounts(evaluation);
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

function renderProviderPolicy(config: BaselineConfig, trials: BaselineTrial[]): string {
  const { approvedModels, disabledProviders } = config.providerPolicy;
  const declared = `Declared policy (source: ${config.modelConfig.source}): approved models ${approvedModels.map((m) => `\`${m}\``).join(', ')}; disabled providers: ${disabledProviders.map((p) => `\`${p}\``).join(', ')}`;

  if (trials.length === 0) {
    return [declared, 'No trials recorded.'].join('\n\n');
  }

  const approvedSet = new Set(approvedModels);
  let anyUnapproved = false;
  let attemptlessCount = 0;

  const bullets = trials.map((trial) => {
    const observed = [...new Set(trial.manifest.modelAttempts.map((a) => a.model))].sort();
    if (observed.length === 0) {
      attemptlessCount += 1;
      return `- \`${trial.id}\`: no model attempts recorded — provider evidence unavailable`;
    }
    const unapproved = observed.filter((m) => !approvedSet.has(m));
    const observedList = observed.map((m) => `\`${m}\``).join(', ');
    if (unapproved.length === 0) {
      return `- \`${trial.id}\`: observed models ${observedList} — all approved`;
    }
    anyUnapproved = true;
    return `- \`${trial.id}\`: observed models ${observedList} — POLICY VIOLATION: ${unapproved.map((m) => `\`${m}\``).join(', ')} not in the approved model set`;
  });

  const verdict = anyUnapproved
    ? 'Ollama disabled: NOT CONFIRMED — at least one recorded model attempt used a model outside the approved set.'
    : attemptlessCount > 0
      ? `Ollama disabled: not confirmable from recorded evidence — ${attemptlessCount} trial(s) recorded no model attempts. A trial without recorded attempts never counts as confirmation.`
      : 'Ollama disabled: confirmed — every trial recorded at least one model attempt and every observed model is in the approved set; no disabled-provider model was observed.';

  return [declared, bullets.join('\n'), verdict].join('\n\n');
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
      `**Status: PRELIMINARY** — only ${trials.length} of the required ${config.comparisonThreshold} trials per configuration have been recorded. Configuration scope: baseline \`${config.baselineId}\`, factory commit \`${config.factory.commit}\`, scbench commit \`${config.scbench.commit}\`, problem catalog commit \`${config.problemCatalog.commit}\`, model config env: ${formatEnv(config.modelConfig.env)}.`,
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
    ['## Provider policy', '', renderProviderPolicy(config, trials)].join('\n'),
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
