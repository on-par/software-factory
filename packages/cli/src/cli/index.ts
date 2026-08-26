// packages/cli/src/cli/index.ts — CLI entry point: factory <command> [options]

import { exec as execCb, execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { Octokit } from '@octokit/rest';
import type {
  BenchmarkRunFailure,
  CheckSummary,
  EnvironmentProxySettings,
  EventKind,
  FactoryConfig,
  FailoverReason,
  FailurePhase,
  GithubIssueParams,
  HealthKpis,
  IngestSettings,
  KpiHistoryRecord,
  LaneProxy,
  LeaseHealth,
  LocalBriefParams,
  LocalOnlyPolicy,
  ModelDiagnosis,
  PrSource,
  QueueDiagnostic,
  ReadinessInfo,
  ReapedLease,
  RepoFactoryConfig,
  SandboxPolicy,
  UsageReading,
  WorkRequest,
  WorkRequestSourceKind,
} from '@on-par/factory-core';
import {
  acquirePortLease,
  appendKpiHistoryLine,
  applyRepoConfig,
  buildPhase,
  checkPhase,
  clearProxyState,
  closedWorkSkipReason,
  computeHealthKpis,
  ConstitutionLoader,
  createDefaultWorkSourceRegistry,
  createFileApprovalGate,
  createLaneProxy,
  defaultFindPortListeners,
  describeEffectiveConfig,
  describeSteering,
  detectPostMergeDefects,
  diagnoseModels,
  drainSteering,
  estimateTrailingSpend,
  fetchDefectSources,
  fetchHumanEventSources,
  fetchSubscriptionUsage,
  formatKpiLines,
  formatUsageReport,
  gateBuildOnBreaker,
  getConstitutionsDir,
  getFactoryPaths,
  GITHUB_ISSUE_SOURCE,
  hasUnresolvedPark,
  InvalidArtifactsDirError,
  InvalidWorkRequestInputError,
  InvalidWorkspaceError,
  inspectPortLeases,
  isCommandAvailable,
  isProxyRunning,
  kpisToHistoryRecord,
  laneBaseUrl,
  laneHostLabel,
  listQueuedSteering,
  loadFactoryConfigForRepo,
  loadModelsConfig,
  loadRepoConfig,
  loadRoutesConfig,
  LOCAL_BRIEF_SOURCE,
  mergedPrRefs,
  ModelRegistry,
  ModelRouter,
  parseKpiHistory,
  parseQueue,
  parseResetCooldownMs,
  planPhase,
  ProcessGroupTracker,
  ProviderBreaker,
  readEvents,
  readPortLeases,
  readUsage,
  reapOrphanProcesses,
  reapStalePortLeases,
  reconstructHumanEvents,
  recordLeasePgid,
  releasePortLease,
  renderKpiReport,
  renderKpiTrend,
  resolveAutoFailover,
  resolveCodexDisabled,
  resolveDefectWindowDays,
  resolveEffectiveModelPins,
  resolveEfficiencyPolicy,
  resolveEnvironmentPorts,
  resolveEnvironmentProxy,
  resolveArtifactsDir,
  resolveIngestConfig,
  resolveLocalOnlyPolicy,
  resolvePlanApproval,
  resolveProcessGroupGraceMs,
  resolveSandboxPolicy,
  resolveSkipCI,
  resolveTimeouts,
  resolveUsageCap,
  ReworkHistory,
  runAutoIngest,
  scoreIssueReadiness,
  shipPhase,
  validateQueue,
  watchUsage,
  writeBenchmarkArtifacts,
  writeLocalRunReport,
  writeProxyState,
} from '@on-par/factory-core';
import type {
  CiOutcome,
  GithubQueue,
  OvernightItemOutcome,
  OvernightPreflightResult,
  OvernightQueueDeps,
  OvernightStateItem,
  QueueClaim,
  QueueIssue,
  QueuePreflightDecision,
  QueueReleaseOutcome,
  WatchChecksOptions,
} from '@on-par/factory-core/internal';
import {
  branchFor,
  branchPrefixSlug,
  cleanupWorktree,
  createFactorydServer,
  createGithubQueue,
  createLocalSmallDryRun,
  createOctokitQueueClient,
  DEFAULT_FACTORYD_PORT,
  defaultRegistryPath,
  ensureDir,
  formatGcReport,
  gitFetch,
  isAutoMergeBlocked,
  laneLabel,
  logCost,
  logEvent,
  QUEUED_LABEL,
  queueLabelSpecs,
  readCosts,
  resolveBranchPrefix,
  resolveEffectiveConfig,
  resolveExperimental,
  resolveFilingPolicy,
  resolveLocalOnly,
  RunLockHeldError,
  runOvernightQueue,
  setupWorktree,
  shellEscape,
  sweepWorktrees,
  watchChecks,
  withFileLock,
  withGitLock,
  withRunLock,
} from '@on-par/factory-core/internal';
import { runTui } from '@on-par/factory-tui';
import chalk from 'chalk';
import { Command } from 'commander';

import {
  analyzeEventLog,
  doctorFailed,
  eventLogCheck,
  formatDoctorChecks,
  formatReconcileReport,
  leaseChecks,
  type LeaseHealthRow,
  runDoctorChecks,
} from './doctor.js';
import { formatOverview, missingClaudeCliMessage, missingTokenMessage, notInitializedMessage } from './first-run.js';
import { cmdLogs } from './logs.js';
import { createFactoryOctokit } from './octokit.js';
import { distFreshnessProbe, runStalenessGuard } from './staleness.js';

const exec = promisify(execCb);
type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<unknown>;

export const PREREQUISITES_TEXT = `Prerequisites:
  - Claude Code CLI installed and authenticated (Claude subscription): https://claude.com/claude-code
  - GitHub CLI authenticated: gh auth login
  - GITHUB_TOKEN or GH_TOKEN set (falls back to \`gh auth token\`)
Run inside a git repository with a GitHub remote.
`;

// ---------- helpers ----------

async function getRepoRoot(): Promise<string> {
  try {
    const { stdout } = await exec('git rev-parse --show-toplevel');
    return stdout.trim();
  } catch {
    throw new CliExitError('factory: not inside a git repository', 2);
  }
}

async function getGitHubRepo(): Promise<string> {
  try {
    const { stdout } = await exec('gh repo view --json nameWithOwner --jq .nameWithOwner');
    return stdout.trim();
  } catch {
    throw new CliExitError('factory: no GitHub remote detected (gh repo view failed)', 2);
  }
}

function getOctokit(): Octokit {
  let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    try {
      const out = execSync('gh auth token', { encoding: 'utf-8', timeout: 5_000 });
      token = out.trim() || undefined;
    } catch {}
  }
  return createFactoryOctokit(token);
}

export function errorDetail(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
  if (stderr) return stderr;
  if (typeof e?.message === 'string' && e.message) return e.message;
  return String(err);
}

export function hasGitHubToken(env: NodeJS.ProcessEnv = process.env, tryToken?: () => string): boolean {
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return true;
  try {
    const out = (tryToken ?? (() => execSync('gh auth token', { encoding: 'utf-8', timeout: 5_000 })))();
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------- commands ----------

async function cmdInit() {
  const repoRoot = await getRepoRoot();
  if (!hasGitHubToken()) {
    console.error(chalk.red(`factory: ${missingTokenMessage()}`));
    process.exit(2);
  }
  const paths = getFactoryPaths(repoRoot);
  ensureDir(paths.state);
  ensureDir(paths.logs);
  ensureDir(paths.plans);

  // Add .factory/ to git exclude
  const excludeFile = resolve(repoRoot, '.git/info/exclude');
  const excludeContent = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf-8') : '';
  if (!excludeContent.includes('.factory/')) {
    writeFileSync(excludeFile, excludeContent + (excludeContent.endsWith('\n') ? '' : '\n') + '.factory/\n');
  }

  console.log(chalk.green(`Initialized ${paths.state}`));
  console.log(`Next: factory constitution --product <name>, then factory triage`);
}

export class ConstitutionExistsError extends Error {}
export class InvalidProductNameError extends Error {}

/** Expected user-facing CLI failure. Thrown by command helpers; only main() maps it to a process exit code. */
export class CliExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliExitError';
  }
}

/** Parse a CLI <issue> argument. Throws CliExitError(2) before any git/GitHub work runs. */
export function parseIssueArg(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new CliExitError(`factory: invalid issue argument '${raw}' — expected a positive integer issue number`, 2);
  }
  return Number(trimmed);
}

/** Deterministic run number for a brief, derived from its content digest.
 *  Reserved 9,000,000+ range keeps brief branches/worktrees clear of real issue numbers. */
function briefRunNumber(sha256Hex: string): number {
  return 9_000_000 + (Number.parseInt(sha256Hex.slice(0, 8), 16) % 1_000_000);
}

// Product names become a filename in the constitutions dir; keep them to a safe,
// listable charset. Leading '_' is reserved (listProducts hides `_*.md`).
export function assertValidProduct(product: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(product)) {
    throw new InvalidProductNameError(
      `invalid product name '${product}': use letters, digits, '.', '_' or '-' and do not start with '_' or '.'`,
    );
  }
}

export interface ReadActiveProductDeps {
  fileExists?: (p: string) => boolean;
  readFile?: (p: string) => string;
}

/**
 * Read the active product name from the `.factory/product` file.
 * Returns the trimmed content, or undefined when the file is missing
 * or contains only whitespace.
 */
export function readActiveProduct(productPath: string, deps: ReadActiveProductDeps = {}): string | undefined {
  const { fileExists = existsSync, readFile = (p: string) => readFileSync(p, 'utf-8') } = deps;
  if (!fileExists(productPath)) return undefined;
  const product = readFile(productPath).trim();
  return product || undefined;
}

/** Extract the template's ```markdown skeleton and fill in the product name. */
export function scaffoldConstitution(template: string, product: string): string {
  const match = template.match(/```markdown\n([\s\S]*?)```/);
  if (!match) {
    throw new Error('constitution template is missing its ```markdown skeleton block');
  }
  const skeleton = match[1].replace(/\s+$/, '') + '\n';
  const display = product
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
  return skeleton.replaceAll('<product-name>', JSON.stringify(product)).replaceAll('<Product>', display);
}

export interface InitConstitutionDeps {
  dir?: string;
  readFile?: (p: string) => string;
  fileExists?: (p: string) => boolean;
  writeFile?: (p: string, data: string) => void;
}

/** Scaffold `<dir>/<product>.md` from the template. Returns the written path. */
export function initConstitution(product: string, deps: InitConstitutionDeps = {}): string {
  const {
    dir = getConstitutionsDir(),
    readFile = (p: string) => readFileSync(p, 'utf-8'),
    fileExists = existsSync,
    writeFile = (p: string, d: string) => writeFileSync(p, d),
  } = deps;
  assertValidProduct(product);
  const target = resolve(dir, `${product}.md`);
  if (fileExists(target)) {
    throw new ConstitutionExistsError(`constitution '${product}' already exists at ${target} — nothing changed`);
  }
  const content = scaffoldConstitution(readFile(resolve(dir, '_template.md')), product);
  writeFile(target, content);
  return target;
}

export async function cmdConstitution(opts: { list?: boolean; product?: string; init?: string }) {
  const loader = new ConstitutionLoader();

  if (opts.init) {
    try {
      const target = initConstitution(opts.init);
      console.log(chalk.green(`Created constitution at ${target}`));
      console.log(
        `Next: edit its Purpose, Standards, and Quality Gates, then run: factory constitution --product ${opts.init}`,
      );
    } catch (err: any) {
      if (err instanceof ConstitutionExistsError) {
        throw new CliExitError(err.message, 1);
      }
      if (err instanceof InvalidProductNameError) {
        throw new CliExitError(err.message, 2);
      }
      throw err;
    }
    return;
  }

  if (opts.list) {
    const products = loader.listProducts();
    for (const p of products) console.log(`  ${p}`);
    return;
  }

  if (opts.product) {
    const constPath = resolve(getConstitutionsDir(), `${opts.product}.md`);
    if (!existsSync(constPath)) {
      throw new CliExitError(`No constitution '${opts.product}' found`, 1);
    }
    const repoRoot = await getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    writeFileSync(paths.product, opts.product);
    console.log(chalk.green(`Active product: ${opts.product}`));
    return;
  }

  throw new CliExitError('usage: factory constitution --init <product> | --list | --product <name>', 2);
}

export function formatDoctorReport(diagnoses: ModelDiagnosis[]): string {
  const lines = [chalk.bold('\n== Model Doctor ==')];
  for (const d of diagnoses) {
    const icon = d.reachable ? chalk.green('✅') : chalk.red('❌');
    const tiers = d.tiers.join('/');
    lines.push(`  ${icon} ${d.model} provider=${d.provider} tier=${tiers} — ${d.reason}`);
  }
  return lines.join('\n');
}

export function hasReachableWorker(diagnoses: ModelDiagnosis[]): boolean {
  return diagnoses.some((d) => d.reachable && (d.tiers.includes('worker') || d.tiers.includes('worker_fallback')));
}

function ollamaModelSet(): Set<string> | undefined {
  try {
    const out = execSync('ollama list', { encoding: 'utf-8', timeout: 10_000 });
    return new Set(
      out
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
  } catch {
    return undefined;
  }
}

async function cmdModels(opts: { doctor?: boolean } = {}) {
  const repoRoot = await getRepoRoot();
  const modelsConfig = applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot));
  const { ModelRegistry } = await import('@on-par/factory-core');
  const registry = new ModelRegistry(modelsConfig);
  const allowExperimental = resolveExperimental();
  const localOnly = resolveLocalOnly();

  if (opts.doctor) {
    const ollamaModels = ollamaModelSet();
    const diagnoses = diagnoseModels(
      registry,
      {
        ollamaModelPresent: ollamaModels ? (model: string) => ollamaModels.has(model) : undefined,
      },
      allowExperimental,
      localOnly,
    );
    console.log(formatDoctorReport(diagnoses));
    if (!hasReachableWorker(diagnoses)) {
      throw new CliExitError('factory: no worker model is reachable — fix the reasons above before running a queue', 1);
    }
    return;
  }

  console.log(chalk.bold('\n== Available Models =='));
  for (const m of registry.list()) {
    const tiers = registry.getTiers(m).join('/');
    const cost = registry.estimateCost(m, 1_000_000, 1_000_000).toFixed(2);
    const gated = registry.isExperimental(m) && !allowExperimental;
    const avail = !gated && registry.isAvailable(m) ? chalk.green('✅') : chalk.red('❌');
    const tag = registry.isExperimental(m) ? chalk.yellow(' [experimental]') : '';
    console.log(`  ${avail} ${m} tier=${tiers} $${cost}/M${tag}`);
  }

  console.log(chalk.bold('\n== Tiers =='));
  for (const tier of ['boss', 'worker', 'checker', 'triage']) {
    const models = registry.getModelsInTier(tier);
    console.log(`  ${tier}: ${models.join(' ')}`);
  }
}

async function cmdCost(opts: { issue?: string } = {}) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const costs = readCosts(paths.costs);

  if (opts.issue) {
    const filtered = costs.filter((c) => c.issue === String(opts.issue));
    if (filtered.length === 0) {
      console.log(`no cost data for issue ${opts.issue}`);
      return;
    }
    console.log(chalk.bold(`== Costs for issue ${opts.issue} ==`));
    for (const c of filtered) {
      console.log(
        `  ${c.task} ${c.model} $${c.cost.toFixed(4)}${c.failoverReason ? ` [failover: ${c.failoverReason}]` : ''}`,
      );
    }
    const total = filtered.reduce((s, c) => s + c.cost, 0);
    console.log('  ---');
    console.log(`  Total: $${total.toFixed(4)}`);
    return;
  }

  if (costs.length === 0) {
    console.log('no cost data yet');
    return;
  }

  const byModel = new Map<string, { tasks: number; total: number; failovers: number }>();
  for (const c of costs) {
    const e = byModel.get(c.model) ?? { tasks: 0, total: 0, failovers: 0 };
    e.tasks++;
    e.total += c.cost;
    if (c.failoverReason) e.failovers++;
    byModel.set(c.model, e);
  }

  console.log(chalk.bold('== Cost Summary =='));
  for (const [model, { tasks, total, failovers }] of byModel) {
    const failoverSuffix = failovers > 0 ? ` (${failovers} failover${failovers === 1 ? '' : 's'})` : '';
    console.log(`  ${model}: ${tasks} tasks, $${total.toFixed(4)}${failoverSuffix}`);
  }
  const grandTotal = costs.reduce((s, c) => s + c.cost, 0);
  console.log('  ---');
  console.log(`  Total: $${grandTotal.toFixed(4)}`);
}

async function cmdReady(issueRaw: string) {
  const issueNum = parseIssueArg(issueRaw);
  const ghRepo = await getGitHubRepo();
  const [owner, repoName] = ghRepo.split('/');
  const { data } = await getOctokit().rest.issues.get({ owner, repo: repoName, issue_number: issueNum });
  const readiness = scoreIssueReadiness({ title: data.title, body: data.body ?? '' });

  if (readiness.pass) {
    console.log(
      chalk.green(
        `issue #${issueNum} is factory-ready (${readiness.template}, score ${Math.round(readiness.score * 100)}%)`,
      ),
    );
    return;
  }

  console.log(
    chalk.yellow(
      `issue #${issueNum} is not factory-ready (${readiness.template}, score ${Math.round(readiness.score * 100)}%)`,
    ),
  );
  for (const field of readiness.missing) {
    console.log(chalk.yellow(`  missing: ${field}`));
  }
  throw new CliExitError(
    `factory: issue #${issueNum} is not factory-ready — missing: ${readiness.missing.join(', ')}`,
    1,
  );
}

async function currentCommitSha(): Promise<string | null> {
  try {
    const { stdout } = await exec('git rev-parse HEAD');
    return stdout.trim();
  } catch {
    return null;
  }
}

function resolvedModelTiers(repoRoot: string): Record<string, string[]> {
  const modelsConfig = applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot));
  return modelsConfig.tiers ?? {};
}

function readTextFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

async function appendKpiSnapshot(
  paths: ReturnType<typeof getFactoryPaths>,
  repoRoot: string,
  kpis: HealthKpis,
): Promise<{ record: KpiHistoryRecord; history: KpiHistoryRecord[] }> {
  const record = kpisToHistoryRecord(kpis, new Date().toISOString().slice(0, 10), {
    commitSha: await currentCommitSha(),
    models: resolvedModelTiers(repoRoot),
  });
  const updated = appendKpiHistoryLine(readTextFileOrEmpty(paths.kpiHistory), record);
  writeFileSync(paths.kpiHistory, updated);
  return { record, history: parseKpiHistory(updated) };
}

async function cmdKpis() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const events = existsSync(paths.events) ? readEvents(paths.events) : [];
  const costs = existsSync(paths.costs) ? readCosts(paths.costs) : [];

  let allEvents = events;
  let prSources: PrSource[] = [];
  let owner = '';
  let repoName = '';
  try {
    const ghRepo = await getGitHubRepo();
    [owner, repoName] = ghRepo.split('/');
    const issues = new Set(events.map((e) => e.issue).filter((i) => /^\d+$/.test(i)));
    prSources = await fetchHumanEventSources(getOctokit(), owner, repoName, issues);
    allEvents = [...events, ...reconstructHumanEvents(prSources, events)];
  } catch (err: any) {
    console.error(
      chalk.yellow(
        `factory: GitHub human-event reconstruction unavailable (${err?.message ?? err}) — KPIs use the local log only`,
      ),
    );
  }

  if (prSources.length > 0) {
    try {
      const windowDays = resolveDefectWindowDays(loadFactoryConfigForRepo(paths.config));
      const now = new Date().toISOString();
      const merged = mergedPrRefs(prSources);
      const sources = await fetchDefectSources(getOctokit(), owner, repoName, merged, { now, windowDays });
      allEvents = [...allEvents, ...detectPostMergeDefects(sources, allEvents, { now, windowDays })];
    } catch (err: any) {
      console.error(
        chalk.yellow(
          `factory: post-merge defect signals unavailable (${err?.message ?? err}) — postMergeDefectRate omitted from this snapshot`,
        ),
      );
    }
  }

  const kpis = computeHealthKpis(allEvents, costs);

  let history: KpiHistoryRecord[];
  try {
    ({ history } = await appendKpiSnapshot(paths, repoRoot, kpis));
  } catch (err: any) {
    console.error(
      chalk.yellow(
        `factory: KPI snapshot failed (${err?.message ?? err}) — showing the report without persisting a new snapshot`,
      ),
    );
    const existing = readTextFileOrEmpty(paths.kpiHistory);
    history = existing ? parseKpiHistory(existing) : [];
  }

  console.log(renderKpiReport(kpis));
  console.log(renderKpiTrend(history));
}

export interface UsageKnobs {
  cap: number;
  stopAt: number;
  resumeAt: number;
  pollMs: number;
  watch: boolean;
  estimator: boolean;
}

export function resolveUsageKnobs(
  env: NodeJS.ProcessEnv = process.env,
  repoConfig: RepoFactoryConfig | null = null,
): UsageKnobs {
  const { cap } = resolveUsageCap(repoConfig, env);

  const stopAt = Number(env.FACTORY_STOP_AT ?? 0.75);
  if (!Number.isFinite(stopAt) || stopAt <= 0 || stopAt > 1) {
    throw new Error('FACTORY_STOP_AT must be a number in (0, 1]');
  }

  const resumeAt = Number(env.FACTORY_RESUME_AT ?? 0.65);
  if (!Number.isFinite(resumeAt) || resumeAt <= 0 || resumeAt > 1) {
    throw new Error('FACTORY_RESUME_AT must be a number in (0, 1]');
  }

  const pollSeconds = Number(env.FACTORY_USAGE_POLL ?? 180);
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error('FACTORY_USAGE_POLL must be a positive number');
  }

  return {
    cap,
    stopAt,
    resumeAt,
    pollMs: pollSeconds * 1000,
    watch: env.FACTORY_USAGE_WATCH !== '0',
    estimator: env.FACTORY_USAGE_ESTIMATOR === '1',
  };
}

export async function cmdUsage() {
  const repoRoot = await getRepoRoot();
  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs(process.env, loadRepoConfig(repoRoot));
  } catch (err: any) {
    throw new CliExitError(`factory: ${err.message}`, 2);
  }

  const subscriptionPromise = fetchSubscriptionUsage();
  const spend = estimateTrailingSpend();
  const heuristicLine = formatUsageReport(spend, knobs.cap);

  const subscription = await subscriptionPromise;
  if (subscription !== null) {
    const resets = subscription.fiveHourResetsAt ? `, resets ${subscription.fiveHourResetsAt}` : '';
    console.log(`5h subscription usage: ${Math.round(subscription.fiveHourUtilization)}% of plan limit${resets}`);
    console.log(`heuristic list-price estimate: ${heuristicLine}`);
  } else {
    console.log(
      chalk.yellow(
        `factory: real subscription usage unavailable — falling back to a rough list-price proxy, not the real subscription limit`,
      ),
    );
    console.log(heuristicLine);
  }
}

function warnQueueDiagnostics(diagnostics: QueueDiagnostic[]): void {
  for (const d of diagnostics) {
    console.error(chalk.yellow(`factory: queue ${d.message} — skipped`));
  }
}

export async function cmdStatus() {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  const repoConfig = loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(loadModelsConfig(), repoConfig);
  const routesConfig = loadRoutesConfig();
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  const product = readActiveProduct(paths.product) ?? '(none)';

  console.log(chalk.bold(`== ${ghRepo} ==`));
  console.log(`Product: ${product}`);

  console.log(chalk.bold('\n== Effective config =='));
  for (const line of describeEffectiveConfig({
    router,
    repo: repoConfig,
    repoConfigPath: '.factory/config.json',
  })) {
    console.log(`  ${line}`);
  }

  console.log(chalk.bold('\n== Provider breaker =='));
  const openBreakers = await new ProviderBreaker(paths.breaker).list();
  if (openBreakers.length === 0) {
    console.log('  (closed)');
  } else {
    for (const b of openBreakers) {
      console.log(`  ${b.provider}: OPEN (${b.reason}) — ${Math.ceil(b.remainingMs / 60_000)}m remaining`);
    }
  }

  console.log(chalk.bold('\n== Queue =='));
  const [owner, repo] = ghRepo.split('/');
  const queue = createGithubQueue({
    client: createOctokitQueueClient(getOctokit()),
    owner,
    repo,
  });
  const lanes = await queue.lanes();
  if (lanes.length === 0) {
    console.log('  (empty)');
  } else {
    for (const lane of lanes) {
      const issues = await queue.list(lane);
      for (const issue of issues) console.log(`  ${lane} ${issue}`);
    }
  }

  console.log(chalk.bold('\n== Last Events =='));
  if (existsSync(paths.events)) {
    const events = readFileSync(paths.events, 'utf-8').trim().split('\n').slice(-12);
    for (const e of events) {
      try {
        const ev = JSON.parse(e);
        console.log(`  ${ev.type} #${ev.issue}: ${ev.msg}`);
      } catch {}
    }
  } else {
    console.log('  (none)');
  }

  console.log(chalk.bold('\n== Health KPIs =='));
  const kpiEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
  const kpiCosts = existsSync(paths.costs) ? readCosts(paths.costs) : [];
  for (const line of formatKpiLines(computeHealthKpis(kpiEvents, kpiCosts))) {
    console.log(`  ${line}`);
  }

  if (existsSync(paths.stop)) {
    console.log(chalk.red('\n!! STOP file present — factory halting between issues'));
  }
}

async function cmdTui() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  let repo: string | undefined;
  try {
    repo = await getGitHubRepo();
  } catch {
    // header just omits the repo
  }
  await runTui({
    eventsFile: paths.events,
    repo,
    stopFile: paths.stop,
    queueProposedFile: paths.queueProposed,
    costsFile: paths.costs,
    approvalsDir: paths.approvals,
    steeringDir: paths.steering,
  });
}

export type ParkReason = Extract<EventKind, 'escalate' | 'timeout' | 'fail' | 'conflict' | 'ci-failed' | 'held'>;

export class LaneParkError extends Error {
  constructor(
    message: string,
    readonly reason: ParkReason,
  ) {
    super(message);
  }
}

export function parkReasonFor(err: unknown): ParkReason {
  if (err instanceof LaneParkError) return err.reason;
  if (err instanceof LandConflictError) return 'conflict';
  if (err instanceof CiFailedError) return 'ci-failed';
  if ((err as any)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

/** Terminal events to emit when a run parks. A timeout park additionally emits
 *  an explicit 'stuck' event so stuckRate observes runs that exceeded their
 *  phase timeout (#428). The other stuck condition — identical checker failures
 *  across consecutive rework rounds — is emitted by the check phase itself. */
export function parkEvents(err: unknown): { type: EventKind; msg: string }[] {
  const reason = parkReasonFor(err);
  const msg = err instanceof Error ? err.message : String(err);
  const events: { type: EventKind; msg: string }[] = [{ type: reason, msg }];
  if (reason === 'timeout') {
    events.push({ type: 'stuck', msg: `run exceeded its phase timeout without progressing — ${msg}` });
  }
  return events;
}

/** Resolves the stable lane URL a build/check agent should use, by probing whether
 *  a factory proxy (started by `factory run`/`supervise` or `factory proxy`) is
 *  currently alive for the configured domain. Never throws — an absent/dead proxy
 *  just degrades to the existing port-based URL, single informational note either way. */
export function resolveLaneBaseUrl(
  paths: ReturnType<typeof getFactoryPaths>,
  settings: EnvironmentProxySettings,
  worktree: string,
  appPort: number | undefined,
  deps: { isRunning?: typeof isProxyRunning } = {},
): { baseUrl?: string; note: string } {
  const { isRunning = isProxyRunning } = deps;
  if (!settings.enabled || appPort === undefined) return { note: '' };

  const state = isRunning(paths.proxyState);
  if (state && state.domain === settings.domain) {
    const baseUrl = laneBaseUrl(worktree, { domain: state.domain, port: state.port });
    return { baseUrl, note: `stable lane URL ${baseUrl} -> 127.0.0.1:${appPort}` };
  }
  return { note: `proxy enabled but not running — using http://127.0.0.1:${appPort}` };
}

export async function shipIssue(
  issueNum: number,
  opts: { product?: string; autoRework?: boolean; interactive?: boolean; sandbox?: boolean; approvePlan?: boolean },
  ctx?: {
    repoRoot: string;
    ghRepo: string;
    lane?: string;
    workRequest?: WorkRequest;
    /** Input source for planPhase to resolve; defaults inside planPhase to this run's GitHub issue. */
    workSource?: { kind: WorkRequestSourceKind; params: unknown };
    /** Local-only policy (#508): run in this caller-provided workspace, skip
     *  worktree creation, disable publishing, and skip the SHIP phase. */
    localOnly?: LocalOnlyPolicy;
    /** Benchmark artifact directory (#509) — only set for local-only runs. */
    artifactsDir?: string;
  },
) {
  const repoRoot = ctx?.repoRoot ?? (await getRepoRoot());
  const ghRepo = ctx?.ghRepo ?? (await getGitHubRepo());
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();

  const repoConfig = loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(loadModelsConfig(), repoConfig);
  const routesConfig = loadRoutesConfig();
  const factoryConfig = loadFactoryConfigForRepo(paths.config);
  const timeouts = resolveTimeouts(factoryConfig);
  const failoverSettings = resolveAutoFailover(factoryConfig);
  const breaker = new ProviderBreaker(paths.breaker);
  const reworkHistory = new ReworkHistory(paths.reworkHistory);
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  const efficiency = resolveEfficiencyPolicy(repoConfig);
  let issueSpend = 0;
  router.setCostSink((entry) => {
    issueSpend += entry.cost;
    logCost(paths.costs, { ...entry, issue: String(issueNum) });
  });
  const modelPins = resolveEffectiveModelPins(router.registryRef, repoConfig);
  const codexOff = resolveCodexDisabled(repoConfig);
  const constitutionLoader = new ConstitutionLoader();

  const product = opts.product ?? readActiveProduct(paths.product);
  const autoRework = opts.autoRework ?? true;

  const work =
    ctx?.workRequest ??
    (await createDefaultWorkSourceRegistry({ octokit }).resolve(GITHUB_ISSUE_SOURCE, {
      repo: ghRepo,
      issue: issueNum,
    } satisfies GithubIssueParams));
  const issueTitle = work.title;
  const branch = branchFor(issueNum, issueTitle, effective.branchPrefix);
  const worktree = ctx?.localOnly
    ? ctx.localOnly.workspace
    : worktreePathFor(repoRoot, issueNum, effective.branchPrefix);
  const specPath = resolve(paths.plans, `issue-${issueNum}.md`);
  const runStartedAt = new Date().toISOString();
  let route: 'codex' | 'claude' | 'opencode' | undefined;
  let failurePhase: FailurePhase = 'plan';
  let checkSummary: CheckSummary | undefined;
  let reworkRounds: number | undefined;

  const lane = ctx?.lane;
  const mkLog =
    (phase?: string) =>
    (
      type: EventKind,
      msg: string,
      extra?: {
        failoverReason?: FailoverReason;
        model?: string;
        tokens?: { input: number; output: number };
        readiness?: ReadinessInfo;
      },
    ) =>
      logEvent(paths.events, type, issueNum, msg, { ...extra, lane, phase });
  const log = mkLog();
  const rememberProviderFailure = async ({
    provider,
    reason,
    detail,
  }: {
    provider: string;
    reason: FailoverReason;
    detail?: string;
  }): Promise<void> => {
    // Weekly/usage-cap errors often report their own reset time (e.g. opencode.ai's
    // "Resets in 3hr 17min"); honor that instead of the flat default cooldown, which
    // is tuned for transient rate limits and reopens the breaker far too early for a
    // multi-hour cap — see #743 (repeated usage_cap trips every ~30min overnight).
    const reportedMs = parseResetCooldownMs(detail ?? '');
    const cooldownMs = reportedMs ?? failoverSettings.cooldownMs;
    await breaker.open(provider, reason, cooldownMs);
    const cooldownNote = reportedMs !== null ? 'provider-reported reset time' : 'default cooldown';
    log(
      'provider_breaker_open',
      `breaker opened for ${provider} (${reason}) — provider skipped until cooldown ends (${cooldownNote}, ${Math.ceil(cooldownMs / 60_000)}m)`,
      { failoverReason: reason },
    );
  };
  const preferFallbackWhenProviderIsOpen = async (
    primary: string | undefined,
    fallback: string | undefined,
    phase: string,
  ): Promise<string | undefined> => {
    if (!primary || !fallback) return primary;
    const provider = router.registryRef.get(primary)?.provider;
    if (!provider) return primary;
    const status = await breaker.status(provider);
    if (!status.open) return primary;
    const minutes = Math.ceil(status.remainingMs / 60_000);
    log(
      'provider_breaker_skip',
      `breaker open for ${provider} (${status.entry.reason}) — using ${fallback} for ${phase}, ${minutes}m remaining`,
    );
    return fallback;
  };
  const assertWithinIssueBudget = (phase: string): void => {
    if (efficiency.perIssueCapUsd === undefined || issueSpend <= efficiency.perIssueCapUsd) return;
    const reason = `per-issue budget exceeded after ${phase}: $${issueSpend.toFixed(2)} > $${efficiency.perIssueCapUsd.toFixed(2)}`;
    log('budget_exceeded', reason);
    throw new LaneParkError(reason, 'fail');
  };
  log('issue-title', issueTitle);
  if (modelPins.plan) {
    const source = modelPins.sources.plan === 'repo' ? '.factory/config.json' : 'FACTORY_PLAN_MODEL';
    log('model-override', `plan model pinned to ${modelPins.plan} (${source})`);
  }
  if (modelPins.build) {
    const source = modelPins.sources.build === 'repo' ? '.factory/config.json' : 'FACTORY_BUILD_MODEL';
    log('model-override', `build model pinned to ${modelPins.build} (${source})`);
  }

  const skipReason = closedWorkSkipReason(work);
  if (skipReason) {
    log('skipped-already-closed', skipReason);
    console.log(chalk.yellow(`skipped: ${skipReason}`));
    throw new IssueSkippedError(skipReason, 'already-closed');
  }

  // Setup worktree FIRST — plan phase needs cwd=worktree to run claude
  if (!ctx?.localOnly) {
    await withGitLock(repoRoot, () =>
      withFileLock(
        paths.gitLock,
        async () => {
          await gitFetch(repoRoot);
          await setupWorktree(repoRoot, branch, worktree);
        },
        { onSteal: (pid) => log('lock-stolen', `stole ${paths.gitLock} from dead holder pid ${pid ?? 'unknown'}`) },
      ),
    );
    await prepareWorktreeDependencies(worktree, log);
    log('worktree', `Worktree ready at ${worktree}`);
  } else {
    log('workspace', `local-only: using caller-provided workspace ${worktree} (no factory worktree created)`);
  }

  // Resolve standards ONCE against the fresh worktree: repo instruction files
  // (CLAUDE.md/AGENTS.md/copilot-instructions.md) win the standards body, a
  // bundled <product>.md is the fallback, and a configured product still
  // contributes its custom checkers. Resolving again later would let the
  // build worker author the standards it is graded by.
  const constitution = constitutionLoader.resolve(worktree, product);
  if (constitution) {
    log(
      'constitution',
      constitution.source === 'repo'
        ? `Standards from repo instruction files${product ? ` (custom checkers from '${product}')` : ''}`
        : `Standards from bundled constitution '${constitution.product}'`,
    );
  } else {
    log('constitution', 'No standards found (no repo instruction files, no constitution) — proceeding without');
  }

  const sandboxPolicy = resolveSandboxPolicy(factoryConfig.sandbox, {
    worktree,
    repoRoot,
    cliDisabled: opts.sandbox === false,
  });
  let activeSandboxPolicy: SandboxPolicy | undefined;
  if (opts.sandbox === false) {
    console.error(chalk.yellow('factory: sandbox disabled by --no-sandbox — agent runs are UNCONTAINED'));
    log('sandbox-disabled', 'sandbox disabled by --no-sandbox');
  } else if (!sandboxPolicy) {
    log('sandbox-disabled', 'sandbox disabled by config/FACTORY_SANDBOX');
  } else if (sandboxPolicy.runtime === 'none') {
    log('sandbox-unavailable', 'no sandbox runtime found (sandbox-exec/firejail) — running uncontained');
  } else {
    activeSandboxPolicy = sandboxPolicy;
    if (sandboxPolicy.allowHosts.length > 0) {
      log(
        'sandbox-degraded',
        `host-level egress filtering unavailable in v1; intended allowlist: ${sandboxPolicy.allowHosts.join(', ')}`,
      );
    }
  }

  const planApprovalEnabled = opts.approvePlan ?? resolvePlanApproval(factoryConfig);

  const processGroupGraceMs = resolveProcessGroupGraceMs(factoryConfig);
  const tracker = new ProcessGroupTracker();
  const onPgid = (pgid: number) => {
    tracker.track(pgid);
    if (appPort !== undefined) {
      void recordLeasePgid({ registryFile: paths.ports, lockDir: paths.portsLock, worktreeId: worktree, pgid }).catch(
        () => {},
      );
    }
  };

  const portsSettings = resolveEnvironmentPorts(factoryConfig);
  let appPort: number | undefined;
  if (portsSettings.enabled) {
    try {
      const reaped: ReapedLease[] = [];
      const lease = await acquirePortLease({
        registryFile: paths.ports,
        lockDir: paths.portsLock,
        worktreeId: worktree,
        branch,
        range: portsSettings.range,
        onReap: (r) => {
          reaped.push(r);
          log(
            'environment_lease_reaped',
            `reaped stale lease: port ${r.lease.port}, pid ${r.lease.pid}, worktree ${r.lease.worktreeId} — reason: ${r.reason}`,
          );
        },
        onPortConflict: (port) => {
          void defaultFindPortListeners(port)
            .then((listeners) => {
              const detail =
                listeners.length > 0
                  ? listeners.map((l) => `pid ${l.pid} (${l.command})`).join(', ')
                  : 'no listener details available';
              log(
                'environment_conflict',
                `port ${port} busy but unleased — reported as conflict, not terminated: ${detail}`,
              );
            })
            .catch(() => {
              log('environment_conflict', `port ${port} busy but unleased — reported as conflict, not terminated`);
            });
        },
      });
      appPort = lease.port;
      log('environment_lease', `leased port ${lease.port} for worktree ${worktree}`);

      if (reaped.length > 0) {
        await reapOrphanProcesses({
          reaped,
          graceMs: processGroupGraceMs,
          onEvent: (e) =>
            log(
              'environment_orphan',
              `${e.action === 'killed' ? 'killed' : 'found'} pid ${e.pid} (pgid ${e.pgid}, ${e.command}) squatting port ${e.port} of dead lane ${e.worktreeId}${e.action === 'reported' ? ' — not factory-started, left running' : ''}`,
            ),
        });
      }
    } catch (err: any) {
      // Port collision is no worse than today — never park a lane over a lease.
      log('environment_lease_failed', `port lease unavailable (${err.message}) — running without injected PORT`);
    }
  } else {
    log('environment_lease', 'port leasing disabled (environment.ports.enabled=false or FACTORY_ENV_PORTS=0)');
  }

  const proxySettings = resolveEnvironmentProxy(factoryConfig);
  const { baseUrl: appBaseUrl, note: proxyNote } = resolveLaneBaseUrl(paths, proxySettings, worktree, appPort);
  if (proxySettings.enabled && appPort !== undefined) {
    log(appBaseUrl ? 'environment_proxy' : 'environment_proxy_unavailable', proxyNote);
  }

  try {
    // PLAN
    const planModel = await preferFallbackWhenProviderIsOpen(modelPins.plan, modelPins.planFallback, 'PLAN');
    const plan = await planPhase({
      issue: issueNum,
      repo: ghRepo,
      worktree,
      specPath,
      constitution,
      router,
      octokit,
      log: mkLog('plan'),
      timeoutSeconds: timeouts.plan,
      modelOverride: planModel,
      modelFallbacks: planModel === modelPins.plan && modelPins.planFallback ? [modelPins.planFallback] : undefined,
      onProviderFailure: rememberProviderFailure,
      branch,
      approvalGate: planApprovalEnabled
        ? createFileApprovalGate({ dir: paths.approvals, timeoutMs: timeouts.approval * 1000 })
        : undefined,
      drainSteering: planApprovalEnabled ? () => drainSteering(paths.steering, issueNum, worktree) : undefined,
      codexDisabled: codexOff,
      localOnly: effective.localOnly,
      laneId: lane,
      workSource: ctx?.workSource,
      enforceReadiness: true,
      fastPath: efficiency.fastPath,
      enforceSizeGate: true,
      preferredRoute: repoConfig?.route,
    });
    route = plan.route;
    if (!plan.ok) {
      const decomposedChildren = plan.decomposed?.childIssues ?? [];
      if (decomposedChildren.length > 0) {
        const childList = decomposedChildren.map((n) => `#${n}`).join(', ');
        mkLog('plan')('decompose_filed', `#${issueNum} decomposed — continuing the lane with ${childList}`);
        throw new IssueDecomposedError(`issue #${issueNum} decomposed into ${childList}`, decomposedChildren);
      }
      throw new LaneParkError(`plan escalated: ${plan.escalate ?? 'unknown'}`, 'escalate');
    }
    assertWithinIssueBudget('PLAN');

    const skipCI = resolveSkipCI(factoryConfig);

    // BUILD
    let buildSteering;
    if (opts.interactive) {
      buildSteering = drainSteering(paths.steering, issueNum, worktree);
      if (buildSteering.messages.length > 0) {
        mkLog('build')('steering_applied', describeSteering(buildSteering));
      }
    }
    let breakerBlocked = false;
    if (failoverSettings.enabled) {
      const providers = [
        ...new Set(
          router
            .resolveAll('build_codex')
            .map((m) => router.registryRef.get(m)?.provider)
            .filter((p): p is string => Boolean(p)),
        ),
      ];
      const gate = await gateBuildOnBreaker({ breaker, providers, log: mkLog('build') });
      breakerBlocked = gate.codexBlocked;
    }

    // A Claude-selected frozen plan must get the same cooldown treatment as
    // the Codex route above. Switch routes before the worker begins so a
    // provider that failed earlier in this run is not called again.
    let buildRoute = plan.route;
    let buildModel = modelPins.build;
    if (failoverSettings.enabled && plan.route === 'claude') {
      const primaryClaude = buildModel ?? router.resolveAll('build_claude')[0];
      const fallbackCodex = modelPins.buildFallback ?? router.resolveAll('build_codex')[0];
      const selected = await preferFallbackWhenProviderIsOpen(primaryClaude, fallbackCodex, 'BUILD');
      if (selected && selected !== primaryClaude) {
        buildRoute = 'codex';
        buildModel = selected;
      }
    }
    if (buildModel) {
      const harnessId = router.registryRef.getHarnessId(buildModel);
      const compatible =
        buildRoute === 'codex'
          ? router.registryRef.isCodexModel(buildModel)
          : buildRoute === 'opencode'
            ? harnessId === 'opencode'
            : harnessId === 'claude-cli';
      if (!compatible) {
        log(
          'model_override_ignored',
          `build model ${buildModel} is incompatible with the ${buildRoute} route — using that route's default worker`,
        );
        buildModel = undefined;
      }
    }

    failurePhase = 'build';
    const build = await buildPhase({
      issue: issueNum,
      repo: ghRepo,
      worktree,
      specPath,
      branch,
      constitution,
      route: buildRoute,
      router,
      log: mkLog('build'),
      timeoutSeconds: timeouts.build,
      skipCI,
      disablePublish: Boolean(ctx?.localOnly),
      modelOverride: buildModel,
      codexFallbackModel: modelPins.buildFallback ?? router.resolveAll('build_codex')[0],
      onProviderFailure: rememberProviderFailure,
      sandbox: activeSandboxPolicy,
      steering: buildSteering,
      appPort,
      appBaseUrl,
      codexDisabled: codexOff || breakerBlocked,
      localOnly: effective.localOnly,
      autoFailover: {
        enabled: failoverSettings.enabled,
        fallbackModel: failoverSettings.fallbackModel,
      },
      onPgid,
      laneId: lane,
    });
    if (!build.ok) {
      throw new LaneParkError(`build escalated: ${build.escalate ?? 'unknown'}`, 'escalate');
    }
    assertWithinIssueBudget('BUILD');

    // CHECK
    failurePhase = 'check';
    // #740: the signature this issue parked/got stuck on in a prior run (if any) — a
    // watchdog that relaunches a dead session sees no memory of it otherwise, and
    // walks straight back into the same rework budget against an unfixed root cause.
    const priorFailureSignature = await reworkHistory.priorSignature(issueNum);
    const check = await checkPhase({
      issue: issueNum,
      worktree,
      specPath,
      constitution,
      router,
      log: mkLog('check'),
      autoRework,
      maxReworkRounds: efficiency.maxReworkRounds,
      buildTimeoutSeconds: timeouts.build,
      checkTimeoutSeconds: timeouts.check,
      sandbox: activeSandboxPolicy,
      drainSteering: opts.interactive ? () => drainSteering(paths.steering, issueNum, worktree) : undefined,
      appPort,
      appBaseUrl,
      onPgid,
      priorFailureSignature,
      reworkRoute: build.route,
      reworkModel: build.model,
      laneId: lane,
    });
    checkSummary = check.summary;
    reworkRounds = check.reworkRounds;
    assertWithinIssueBudget('CHECK');
    for (const s of check.summary.results.filter((r) => r.result === 'SKIP')) {
      console.error(chalk.yellow(`  SKIP: ${s.checker} — ${s.details}`));
    }
    if (!check.passed) {
      const failures = check.summary.results.filter((r) => r.result === 'FAIL');
      for (const f of failures) {
        console.error(chalk.red(`  FAIL: ${f.checker} — ${f.details}`));
      }
      if (check.failureSignature !== undefined) {
        await reworkHistory.record(
          issueNum,
          check.failureSignature,
          failures.map((f) => f.checker),
        );
      }
      throw new LaneParkError(
        check.crossRunStuck
          ? `issue held: identical failure signature parked this lane in a prior run too (${check.reworkRounds} rework rounds burned there, 0 here) — needs a human decision`
          : check.stuck
            ? `lane stuck after ${check.reworkRounds} rework rounds (identical failures) — escalated`
            : `${check.summary.failures} check failures after ${check.reworkRounds} rework rounds`,
        check.crossRunStuck ? 'held' : check.stuck ? 'escalate' : 'fail',
      );
    }
    // Clean check (first try or after rework fixed it) — clear any stale history
    // for this issue so a future, genuinely different failure isn't mistaken for
    // a repeat of one that's already resolved.
    await reworkHistory.clear(issueNum);

    if (ctx?.localOnly) {
      log('local-only-complete', `local-only run complete in ${worktree} — publishing disabled, no PR created`);
      const reportPath = await maybeWriteLocalRunReport({
        issueNum,
        paths,
        startedAt: runStartedAt,
        outcome: 'ready',
        branch,
        worktree,
        specPath,
        route,
      });
      await maybeWriteBenchmarkArtifacts({
        issueNum,
        paths,
        ctx,
        startedAt: runStartedAt,
        outcome: 'ready',
        branch,
        specPath,
        route,
        checkSummary,
        reworkRounds,
        reportPath,
        log,
      });
      console.log(chalk.green(`✅ Local-only run complete in ${worktree} (no PR — publishing disabled)`));
      return branch;
    }

    // SHIP
    failurePhase = 'ship';
    const approvalGate = opts.interactive
      ? createFileApprovalGate({ dir: paths.approvals, timeoutMs: timeouts.approval * 1000 })
      : undefined;
    const ship = await shipPhase({
      issue: issueNum,
      repo: ghRepo,
      worktree,
      branch,
      octokit,
      watchCI: !skipCI,
      log: mkLog('ship'),
      approvalGate,
      checkSummary: check.summary,
      specPath,
      eventsFile: paths.events,
      startedAt: runStartedAt,
      logsDir: paths.logs,
      reworkRounds: check.reworkRounds,
      work: ctx?.workRequest,
      laneId: lane,
    });
    if (!ship.ok) {
      throw new LaneParkError(
        ship.denied ? `ship denied: ${ship.deniedReason}` : 'ship phase failed',
        ship.denied ? 'escalate' : 'fail',
      );
    }

    if (skipCI) {
      log('skip-ci', `skipping CI watch (FACTORY_SKIP_CI=1) — merging on local verify`);
    }

    if (opts.interactive) {
      const leftover = listQueuedSteering(paths.steering, issueNum);
      if (leftover.length > 0) {
        log('steering_unconsumed', `${leftover.length} steering message(s) not consumed (no worker phase remained)`);
      }
    }

    const readyMsg = ship.alreadyDelivered
      ? `already delivered${ship.prNumber !== undefined ? ` by merged PR #${ship.prNumber}` : ' — branch already landed on main'}`
      : `PR #${ship.prNumber} ready for review`;
    log('ready', readyMsg);
    await maybeWriteLocalRunReport({
      issueNum,
      paths,
      startedAt: runStartedAt,
      outcome: 'ready',
      branch,
      worktree,
      specPath,
      route,
    });
    console.log(chalk.green(`✅ Issue #${issueNum} → ${readyMsg}`));
    return branch;
  } catch (err: any) {
    if (err instanceof IssueDecomposedError) throw err;
    for (const e of parkEvents(err)) log(e.type, e.msg);
    const reportPath = await maybeWriteLocalRunReport({
      issueNum,
      paths,
      startedAt: runStartedAt,
      outcome: parkReasonFor(err) === 'escalate' ? 'escalated' : 'failed',
      branch,
      worktree,
      specPath,
      route,
      reason: err.message,
    });
    await maybeWriteBenchmarkArtifacts({
      issueNum,
      paths,
      ctx,
      startedAt: runStartedAt,
      outcome: parkReasonFor(err) === 'escalate' ? 'escalated' : 'failed',
      branch,
      specPath,
      route,
      checkSummary,
      reworkRounds,
      failure: { phase: failurePhase, reason: parkReasonFor(err), message: err.message },
      reportPath,
      log,
    });
    throw err;
  } finally {
    const outcomes = await tracker.killAll({ graceMs: processGroupGraceMs });
    if (outcomes.length > 0) {
      log(
        'environment_cleanup',
        `terminated ${outcomes.length} process group(s)${outcomes.some((o) => o.forced) ? ' (SIGKILL escalation used)' : ''}`,
      );
    }
    if (appPort !== undefined) {
      await releasePortLease({ registryFile: paths.ports, lockDir: paths.portsLock, worktreeId: worktree })
        .then(() => log('environment_release', `released port ${appPort} for worktree ${worktree}`))
        .catch((e: any) => log('environment_release_failed', `port release failed: ${e.message}`));
    }
  }
}

async function maybeWriteLocalRunReport(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  startedAt: string;
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  branch?: string;
  worktree?: string;
  specPath?: string;
  route?: string;
  reason?: string;
}): Promise<string | undefined> {
  if (process.env.FACTORY_LOCAL_ONLY !== '1') return undefined;
  const report = await writeLocalRunReport({
    issue: opts.issueNum,
    eventsFile: opts.paths.events,
    reportsDir: opts.paths.reports,
    startedAt: opts.startedAt,
    outcome: opts.outcome,
    profile: 'local-only',
    branch: opts.branch,
    worktree: opts.worktree,
    specPath: opts.specPath,
    route: opts.route,
    reason: opts.reason,
  });
  console.log(chalk.cyan(`local-only report: ${report.path}`));
  return report.path;
}

async function maybeWriteBenchmarkArtifacts(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  ctx?: { localOnly?: LocalOnlyPolicy; artifactsDir?: string; workRequest?: WorkRequest };
  startedAt: string;
  outcome: 'ready' | 'failed' | 'escalated';
  branch?: string;
  specPath?: string;
  route?: string;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  failure?: BenchmarkRunFailure;
  reportPath?: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<void> {
  if (!opts.ctx?.localOnly || !opts.ctx.artifactsDir) return;
  try {
    const { manifestPath } = await writeBenchmarkArtifacts({
      issue: opts.issueNum,
      artifactsDir: opts.ctx.artifactsDir,
      eventsFile: opts.paths.events,
      costsFile: opts.paths.costs,
      startedAt: opts.startedAt,
      outcome: opts.outcome,
      workspace: opts.ctx.localOnly.workspace,
      branch: opts.branch,
      specPath: opts.specPath,
      route: opts.route,
      request: opts.ctx.workRequest,
      checkSummary: opts.checkSummary,
      reworkRounds: opts.reworkRounds,
      failure: opts.failure,
      reportPath: opts.reportPath,
    });
    opts.log('benchmark-artifacts', `manifest written to ${manifestPath}`);
    console.log(chalk.cyan(`benchmark artifacts: ${manifestPath}`));
  } catch (err: any) {
    // Never let artifact emission mask the run outcome.
    opts.log('benchmark-artifacts-failed', `could not write benchmark artifacts: ${err.message}`);
  }
}

async function cmdShip(
  issueNum: number,
  opts: { product?: string; autoRework?: boolean; interactive?: boolean; sandbox?: boolean; approvePlan?: boolean },
) {
  if (!isCommandAvailable('claude')) {
    throw new CliExitError(`factory: ${missingClaudeCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.state)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  return withRepoRunLock(paths, 'factory ship', async () => {
    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(issueNum))) {
      logEvent(paths.events, 'human-restarted', issueNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      return await shipIssue(issueNum, opts);
    } catch (err: any) {
      if (err instanceof IssueSkippedError) return;
      throw new CliExitError(`Ship failed for issue #${issueNum}: ${err.message}`, 1);
    }
  });
}

async function cmdRunIssue(
  issueNum: number,
  opts: { product?: string; autoRework?: boolean; interactive?: boolean; sandbox?: boolean; approvePlan?: boolean },
) {
  if (!isCommandAvailable('claude')) {
    throw new CliExitError(`factory: ${missingClaudeCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.state)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  await withRepoRunLock(paths, 'factory run-issue', async () => {
    const ghRepo = await getGitHubRepo();

    // Pre-flight: resolve the issue through the canonical work-request seam
    // BEFORE any worktree or PR exists — a bad issue exits here.
    const workSources = createDefaultWorkSourceRegistry({ octokit: getOctokit() });
    let work: WorkRequest;
    try {
      work = await workSources.resolve(GITHUB_ISSUE_SOURCE, {
        repo: ghRepo,
        issue: issueNum,
      } satisfies GithubIssueParams);
    } catch (err) {
      if (err instanceof InvalidWorkRequestInputError) {
        throw new CliExitError(`factory: ${err.message}`, 2);
      }
      throw new CliExitError(
        `factory: could not resolve issue #${issueNum} in ${ghRepo} (${errorDetail(err)}) — no worktree or PR was created`,
        2,
      );
    }
    console.log(chalk.cyan(`one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));

    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(issueNum))) {
      logEvent(paths.events, 'human-restarted', issueNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      await shipIssue(issueNum, opts, { repoRoot, ghRepo, workRequest: work });
    } catch (err: any) {
      if (err instanceof IssueSkippedError) return;
      throw new CliExitError(`Run failed for issue #${issueNum}: ${err.message}`, 1);
    }
  });
}

async function cmdRunBrief(
  briefPath: string,
  opts: {
    product?: string;
    autoRework?: boolean;
    interactive?: boolean;
    sandbox?: boolean;
    approvePlan?: boolean;
    workspace?: string;
    artifacts?: string;
  },
) {
  if (!isCommandAvailable('claude')) {
    throw new CliExitError(`factory: ${missingClaudeCliMessage()}`, 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.state)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }

  await withRepoRunLock(paths, 'factory run-brief', async () => {
    let localOnly: LocalOnlyPolicy | undefined;
    if (opts.workspace !== undefined) {
      try {
        localOnly = resolveLocalOnlyPolicy(opts.workspace);
      } catch (err) {
        if (err instanceof InvalidWorkspaceError) throw new CliExitError(`factory: ${err.message}`, 2);
        throw err;
      }
    }

    let artifactsDir: string | undefined;
    if (opts.artifacts !== undefined) {
      if (!localOnly) {
        throw new CliExitError('factory: --artifacts requires --workspace (local-only runs only)', 2);
      }
      try {
        artifactsDir = resolveArtifactsDir(opts.artifacts);
      } catch (err) {
        if (err instanceof InvalidArtifactsDirError) throw new CliExitError(`factory: ${err.message}`, 2);
        throw err;
      }
      console.log(chalk.cyan(`local-only: benchmark artifacts will be written to ${artifactsDir}`));
    }

    // Local-only runs never touch GitHub — no remote required, no mutation possible.
    const ghRepo = localOnly ? 'local/workspace' : await getGitHubRepo();

    // Pre-flight: resolve the brief through the canonical work-request seam
    // BEFORE any worktree or PR exists — a malformed brief exits here, so BUILD never starts.
    const workSources = createDefaultWorkSourceRegistry({ octokit: getOctokit() });
    let work: WorkRequest;
    try {
      work = await workSources.resolve(LOCAL_BRIEF_SOURCE, { path: briefPath } satisfies LocalBriefParams);
    } catch (err) {
      if (err instanceof InvalidWorkRequestInputError) {
        throw new CliExitError(`factory: ${err.message}`, 2);
      }
      throw new CliExitError(
        `factory: could not resolve brief at ${briefPath} (${errorDetail(err)}) — no worktree or PR was created`,
        2,
      );
    }
    const digest = work.reference?.externalId ?? '';
    const runNum = briefRunNumber(digest);
    console.log(chalk.cyan(`one-shot: resolved ${work.id} — running the pipeline (queue untouched)`));
    logEvent(paths.events, 'work-source', runNum, `inline local brief ${briefPath} (sha256 ${digest})`);
    if (localOnly) {
      console.log(chalk.cyan(`local-only: workspace ${localOnly.workspace} — publishing disabled`));
      logEvent(
        paths.events,
        'local-only',
        runNum,
        `caller-provided workspace ${localOnly.workspace} — publishing disabled`,
      );
    }

    const priorEvents = existsSync(paths.events) ? readEvents(paths.events) : [];
    if (hasUnresolvedPark(priorEvents, String(runNum))) {
      logEvent(paths.events, 'human-restarted', runNum, 'manual retry of a previously parked/failed run', {
        actor: process.env.FACTORY_ACTOR ?? process.env.USER ?? 'unknown',
      });
    }

    try {
      await shipIssue(runNum, opts, {
        repoRoot,
        ghRepo,
        workRequest: work,
        workSource: { kind: LOCAL_BRIEF_SOURCE, params: { path: briefPath } satisfies LocalBriefParams },
        localOnly,
        artifactsDir,
      });
    } catch (err: any) {
      throw new CliExitError(`Run failed for brief ${briefPath}: ${err.message}`, 1);
    }
  });
}

async function cmdLocalSmallDryRun(issueNum: number, opts: { spec?: string; output?: string }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();
  const [owner, repoName] = ghRepo.split('/');
  const specPath = resolve(repoRoot, opts.spec ?? resolve(paths.plans, `issue-${issueNum}.md`));
  const outputDir = resolve(repoRoot, opts.output ?? resolve(paths.state, 'local-small', `issue-${issueNum}`));
  const { data: issue } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issueNum });

  const result = await createLocalSmallDryRun({
    issue: issueNum,
    issueTitle: issue.title,
    issueBody: issue.body ?? '',
    repoRoot,
    specPath,
    outputDir,
  });

  console.log(chalk.green(`local-small dry run: ${result.planPath}`));
  console.log(chalk.green(`local-small context: ${result.contextPath}`));
}

async function cmdLocalSmallOvernight(opts: { queue?: string; state?: string }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const queueFile = resolve(repoRoot, opts.queue ?? resolve(paths.state, 'local-small', 'overnight-queue'));
  const statePath = resolve(repoRoot, opts.state ?? resolve(paths.state, 'local-small', 'overnight-state.json'));

  if (!existsSync(queueFile)) {
    throw new CliExitError(
      `factory: overnight queue not found at ${queueFile} — create it with "<lane> <issue#>" lines`,
      2,
    );
  }

  const { entries, diagnostics } = parseQueue(readFileSync(queueFile, 'utf-8'));
  warnQueueDiagnostics(diagnostics);
  if (entries.length === 0) {
    throw new CliExitError(`factory: overnight queue at ${queueFile} has no valid entries`, 2);
  }

  await withRepoRunLock(paths, 'factory local-small-overnight', async () => {
    const ghRepo = await getGitHubRepo();
    process.env.FACTORY_LOCAL_ONLY = '1';

    const preflight = async (): Promise<OvernightPreflightResult> => {
      if (!isCommandAvailable('claude')) return { ok: false, reason: missingClaudeCliMessage() };
      const registry = new ModelRegistry(applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot)));
      const ollamaModels = ollamaModelSet();
      const diagnoses = diagnoseModels(
        registry,
        { ollamaModelPresent: ollamaModels ? (m: string) => ollamaModels.has(m) : undefined },
        resolveExperimental(),
        true, // localOnly
      );
      if (!hasReachableWorker(diagnoses)) {
        const reasons = diagnoses.filter((d) => !d.reachable).map((d) => `${d.model}: ${d.reason}`);
        return { ok: false, reason: `no reachable local worker model — ${reasons.join('; ')}` };
      }
      return { ok: true };
    };

    const processItem = async (issue: number): Promise<OvernightItemOutcome> => {
      try {
        await shipIssue(issue, { autoRework: true, interactive: false }, { repoRoot, ghRepo, lane: 'overnight' });
        return { status: 'ready' };
      } catch (err: any) {
        if (err instanceof IssueSkippedError) return { status: 'parked', reason: err.message };
        return parkReasonFor(err) === 'escalate'
          ? { status: 'parked', reason: err.message }
          : { status: 'failed', reason: err.message };
      }
    };

    const report = (item: OvernightStateItem) => {
      console.log(chalk.yellow(`factory: issue #${item.issue} ${item.status} — ${item.reason ?? 'unknown'}`));
      logEvent(
        paths.events,
        'overnight-park',
        item.issue,
        `${item.status}: ${item.reason ?? 'unknown'} — see ${paths.reports}`,
      );
    };
    const log = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);

    const deps: OvernightQueueDeps = { preflight, processItem, report, log };
    const result = await runOvernightQueue({ issues: entries.map((e) => e.issue), statePath }, deps);

    const ready = result.processed.filter((item) => item.status === 'ready');
    const parked = result.processed.filter((item) => item.status === 'parked');
    const failed = result.processed.filter((item) => item.status === 'failed');
    console.log(chalk.green(`overnight ready: ${ready.length}`));
    console.log(chalk.yellow(`overnight parked: ${parked.length}`));
    console.log(chalk.red(`overnight failed: ${failed.length}`));
    console.log(chalk.yellow(`overnight skipped (already resumed): ${result.skipped.length}`));

    if (result.halted) {
      throw new CliExitError(
        `factory: overnight halted before issue #${result.halted.issue}: ${result.halted.reason} — fix the environment and re-run to resume`,
        4,
      );
    }
  });
}

async function getIssueTitle(octokit: Octokit, repo: string, issue: number): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
  return data.title;
}

function worktreePathFor(repoRoot: string, issueNum: number, prefix?: string): string {
  return resolve(dirname(repoRoot), `${basename(repoRoot)}-factory-${branchPrefixSlug(prefix)}-${issueNum}`);
}

async function prepareWorktreeDependencies(
  worktree: string,
  log: (type: EventKind, msg: string) => void,
): Promise<void> {
  if (!existsSync(join(worktree, 'package-lock.json'))) return;
  if (existsSync(join(worktree, 'node_modules', '.package-lock.json'))) return;

  log('worktree', 'installing npm dependencies for fresh worktree');
  try {
    await exec('npm install --ignore-scripts --no-audit --no-fund', {
      cwd: worktree,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    log('worktree', 'npm dependencies ready');
  } catch (err) {
    log('worktree', `npm dependency install failed: ${errorDetail(err)}`);
  }
}

/** Fences a whole run behind the checkout's `.factory/run.lock` (#598). A live holder is
 *  refused immediately — never queued behind a multi-hour run — and a dead holder's lock is
 *  reclaimed by withRunLock. Nested acquisition inside one process is a pass-through, so
 *  `factory supervise` can hold this across its loop. */
export async function withRepoRunLock<T>(
  paths: ReturnType<typeof getFactoryPaths>,
  command: string,
  fn: () => Promise<T>,
  deps: { runLock?: typeof withRunLock; emitEvent?: typeof logEvent } = {},
): Promise<T> {
  const { runLock = withRunLock, emitEvent = logEvent } = deps;
  try {
    return await runLock(paths.runLock, fn, {
      command,
      onReclaim: (pid) =>
        emitEvent(
          paths.events,
          'lock-stolen',
          '-',
          `reclaimed ${paths.runLock} from dead holder pid ${pid ?? 'unknown'}`,
        ),
    });
  } catch (err) {
    if (err instanceof RunLockHeldError) {
      emitEvent(paths.events, 'run_lock_conflict', '-', `${command} refused: ${err.message}`);
      throw new CliExitError(
        `factory: ${err.message} — stop that run (or wait for it to finish) before starting another. ` +
          `A dead run's lock is reclaimed automatically; remove ${paths.runLock} only if you are sure no factory run is live.`,
        2,
      );
    }
    throw err;
  }
}

export async function cmdWorktreeGc(opts: { dryRun?: boolean; ttlDays?: string }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = loadFactoryConfigForRepo(paths.config);
  const ttlDays = opts.ttlDays !== undefined ? Number(opts.ttlDays) : factoryConfig.worktree.gcTtlDays;
  if (!Number.isFinite(ttlDays) || ttlDays < 0) {
    throw new CliExitError('factory: --ttl-days must be a non-negative number', 2);
  }
  const log = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
  // Best-effort GitHub evidence: tokenless/local-only repos keep today's pure-local behavior.
  const ghRepo = await getGitHubRepo().catch(() => undefined);
  const octokit = ghRepo ? (hasGitHubToken() ? getOctokit() : undefined) : undefined;
  const run = () => sweepWorktrees({ repoRoot, ttlDays, dryRun: opts.dryRun, repo: ghRepo }, { log, octokit });
  const report = opts.dryRun ? await run() : await withGitLock(repoRoot, () => withFileLock(paths.gitLock, run));
  console.log(formatGcReport(report));
}

export async function cmdLand(issueNum: number) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();
  const factoryConfig = loadFactoryConfigForRepo(paths.config);
  const skipCI = resolveSkipCI(factoryConfig);

  try {
    const result = await landIssue(issueNum, repoRoot, ghRepo, paths, octokit, skipCI);
    console.log(chalk.green(`✅ Landed PR #${result.prNumber} for issue #${issueNum}`));
  } catch (err: any) {
    if (err instanceof AwaitingReviewError) {
      console.log(chalk.yellow(`⏸ PR #${err.prNumber} for issue #${issueNum} awaiting human review — left open`));
      return;
    }
    if (err instanceof CiUnverifiedError) {
      console.log(
        chalk.yellow(
          `⏸ PR #${err.prNumber} for issue #${issueNum} — CI never reached a green verdict — left open, not merged`,
        ),
      );
      return;
    }
    if (err instanceof CiFailedError) {
      console.log(
        chalk.yellow(`⏸ PR #${err.prNumber} for issue #${issueNum} has a failing CI check — left open, not merged`),
      );
      return;
    }
    if (err instanceof LandConflictError) {
      throw new CliExitError(`factory: ${err.message}`, 3);
    }
    if (err instanceof LandFailureError) {
      throw new CliExitError(`factory: ${err.message}`, err.code);
    }
    throw new CliExitError(`factory: merge failed for issue #${issueNum}: ${err.message}`, 5);
  }
}

async function landIssue(
  issueNum: number,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  octokit: Octokit,
  skipCI?: boolean,
): Promise<{ branch: string; prNumber: number }> {
  const [owner, repoName] = ghRepo.split('/');
  const log = (type: EventKind, msg: string, extra?: { failoverReason?: FailoverReason }) =>
    logEvent(paths.events, type, issueNum, msg, extra);

  // The issue title may have been edited since the PR was opened, so a
  // freshly-derived branch name can drift from the branch the PR actually
  // lives on (same failure mode fixed for waitForMerge in #51). Guess the
  // branch from the current title first, but fall back to matching the open
  // PR that references this issue directly and use its real head branch.
  const branchPrefix = resolveEffectiveConfig(loadRepoConfig(repoRoot)).branchPrefix;
  const guessedBranch = branchFor(issueNum, await getIssueTitle(octokit, ghRepo, issueNum), branchPrefix);
  const worktree = worktreePathFor(repoRoot, issueNum, branchPrefix);

  let branch = guessedBranch;
  let prNumber: number | undefined;
  try {
    [, prNumber] = await Promise.all([gitFetch(repoRoot), findOpenPRNumber(octokit, owner, repoName, guessedBranch)]);
    if (!prNumber) {
      const fallback = await findOpenPRForIssue(octokit, owner, repoName, issueNum);
      if (fallback) {
        branch = fallback.branch;
        prNumber = fallback.number;
      }
    }
  } catch (err) {
    const failure = prLookupFailure(issueNum, guessedBranch, err);
    log('fail', failure.message);
    throw failure;
  }

  if (!prNumber) {
    log('fail', `no open PR for ${guessedBranch}`);
    throw new LandFailureError(`no open PR for issue #${issueNum} (${guessedBranch})`, 1);
  }

  const withLandLock: LandLock = (fn) =>
    withGitLock(repoRoot, () =>
      withFileLock(paths.mergeLock, fn, {
        onSteal: (pid) => log('lock-stolen', `stole ${paths.mergeLock} from dead holder pid ${pid ?? 'unknown'}`),
      }),
    );

  try {
    try {
      await landOpenPullRequest({
        octokit,
        owner,
        repoName,
        ghRepo,
        repoRoot,
        issue: issueNum,
        branch,
        worktree,
        prNumber: prNumber!,
        log,
        skipCI,
        withLock: withLandLock,
        ensureWorktree: async () => {
          if (!existsSync(worktree)) {
            await setupWorktree(repoRoot, branch, worktree, `origin/${branch}`);
          }
        },
      });
    } catch (err) {
      if (err instanceof AwaitingReviewError || err instanceof CiFailedError) {
        await withLandLock(() => cleanupWorktree(repoRoot, worktree, log));
      }
      throw err;
    }
    log('merged', `squash-merged PR #${prNumber}`);
    await withLandLock(() => cleanupWorktree(repoRoot, worktree, log));
  } catch (err: any) {
    if (err instanceof LandConflictError || err instanceof AwaitingReviewError || err instanceof CiFailedError)
      throw err;
    log('fail', `merge failed: ${err.message}`);
    throw new LandFailureError(`merge failed for issue #${issueNum}: ${err.message}`, 5);
  }

  return { branch, prNumber };
}

export function prLookupFailure(issueNum: number, branch: string, err: unknown): LandFailureError {
  return new LandFailureError(`PR lookup failed for issue #${issueNum} (${branch}): ${errorDetail(err)}`, 5);
}

async function cmdTriage(opts: { product?: string }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  if (!existsSync(paths.state)) {
    throw new CliExitError(`factory: ${notInitializedMessage()}`, 2);
  }
  const product = opts.product ?? readActiveProduct(paths.product);

  const repoConfig = loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(loadModelsConfig(), repoConfig);
  const routesConfig = loadRoutesConfig();
  const effective = resolveEffectiveConfig(repoConfig);
  const router = new ModelRouter(
    modelsConfig,
    routesConfig,
    false,
    undefined,
    effective.allowExperimental,
    effective.localOnly,
  );
  const model = router.resolve('triage') ?? 'claude-sonnet-5';
  const flag = router.registryRef.getClaudeFlag(model);

  const constitutionNote = product ? `Active constitution: ${product}.` : '';
  const prompt = `Triage the open GitHub issues of ${ghRepo} for an autonomous software factory.
${constitutionNote}
Run: gh issue list --repo ${ghRepo} --state open --limit 100 --json number,title,labels,body
Read every body. Exclude epics/PRDs/meta, external-account/credential/outreach issues,
and anything too vague. Group by lane (same-file issues together). Order by dependency then value.
Write ONLY the queue to ${paths.queueProposed} in format '<lane> <issue#>', with '#' comments
explaining exclusions.`;

  let plannerError: unknown;
  logEvent(paths.events, 'triage', '-', `Triaging ${ghRepo} with ${model}`);
  await exec(
    `claude -p ${shellEscape(prompt)} ${flag ? `--model ${flag}` : ''} --allowedTools "Bash(gh issue:*)" "Bash(gh repo:*)" Read Glob Grep Write`,
  ).catch((err: unknown) => {
    plannerError = err;
    logEvent(paths.events, 'warn', '-', `triage planner failed: ${errorDetail(err)}`);
  });

  const proposed = existsSync(paths.queueProposed) ? readFileSync(paths.queueProposed, 'utf-8') : '';
  const message = triageProposalMessage(proposed, paths.queueProposed);
  if (message) {
    console.log(message);
  } else {
    throw triageNoProposalError(plannerError);
  }
}

export function triageProposalMessage(proposed: string, proposedPath: string): string | null {
  if (!proposed.trim()) return null;
  return `${proposed}\n---\nreview and run: factory triage accept   (labels proposed issues from ${proposedPath})`;
}

export async function cmdTriageAccept(opts: { force?: boolean }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  if (!existsSync(paths.queueProposed)) {
    console.log(`nothing to accept — ${paths.queueProposed} not found`);
    return; // zero exit
  }

  const content = readFileSync(paths.queueProposed, 'utf-8');
  const result = validateQueue(content);
  const parsed = parseQueue(content);

  if (!opts.force && !result.ok) {
    throw new CliExitError(
      `factory: proposed queue is invalid — ${paths.queueProposed} left unchanged\n` +
        result.errors.map((e) => `  - ${e}`).join('\n'),
      1,
    );
  }

  const [owner, repo] = ghRepo.split('/');
  const queueClient = createOctokitQueueClient(getOctokit());
  const ensuredLanes = new Set<string>();
  for (const entry of parsed.entries) {
    if (!ensuredLanes.has(entry.lane)) {
      for (const spec of queueLabelSpecs(entry.lane, 'triage-accept')) {
        await queueClient.ensureLabel({ owner, repo, ...spec });
      }
      ensuredLanes.add(entry.lane);
    }
    await queueClient.addLabels({
      owner,
      repo,
      issue_number: entry.issue,
      labels: [QUEUED_LABEL, laneLabel(entry.lane)],
    });
  }

  unlinkSync(paths.queueProposed);

  let acceptedBy = 'unknown';
  try {
    acceptedBy = userInfo().username;
  } catch {
    /* keep 'unknown' */
  }
  const suffix = opts.force ? ' (--force, validation skipped)' : '';
  logEvent(
    paths.events,
    'triage_accepted',
    '-',
    `accepted ${parsed.entries.length} issue(s) [${parsed.entries.map((entry) => entry.issue).join(', ')}] by ${acceptedBy}${suffix}`,
  );
  console.log(chalk.green(`queue accepted — ${parsed.entries.length} issue(s) labeled in ${ghRepo}`));
}

export function triageNoProposalError(plannerError: unknown): CliExitError {
  const detail = plannerError ? ` — planner failed: ${errorDetail(plannerError)}` : '';
  return new CliExitError(`triage produced no proposal${detail}`, 1);
}

/** Starts the in-process lane proxy for `factory run`/`supervise` when
 *  `environment.proxy.enabled`. Never throws: a bind failure (EACCES on :80,
 *  EADDRINUSE, …) is logged as a single `environment_proxy_unavailable` event
 *  and lanes degrade to port-based URLs, exactly as if the proxy were disabled. */
export async function startLaneProxy(
  paths: ReturnType<typeof getFactoryPaths>,
  settings: EnvironmentProxySettings,
  deps: { createProxy?: typeof createLaneProxy; emitEvent?: typeof logEvent } = {},
): Promise<{ proxy?: LaneProxy }> {
  if (!settings.enabled) return {};
  const { createProxy = createLaneProxy, emitEvent = logEvent } = deps;

  const proxy = createProxy({ registryFile: paths.ports, domain: settings.domain, port: settings.port });
  try {
    const boundPort = await proxy.start();
    writeProxyState(paths.proxyState, {
      version: 1,
      pid: process.pid,
      port: boundPort,
      domain: settings.domain,
      startedAt: new Date().toISOString(),
    });
    emitEvent(
      paths.events,
      'environment_proxy',
      'all',
      `lane proxy listening on 127.0.0.1:${boundPort} (*.${settings.domain})`,
    );
    return { proxy };
  } catch (err: any) {
    emitEvent(
      paths.events,
      'environment_proxy_unavailable',
      'all',
      `proxy unavailable (${err.message}) — lanes use port-based URLs`,
    );
    return {};
  }
}

/** Runs the lane proxy in the foreground for manual use alongside single-lane
 *  `factory ship` (which only probes proxy.json and degrades — it never spawns
 *  a proxy itself). Running this command IS the opt-in: it starts even when
 *  environment.proxy.enabled is false in factory.json. */
async function cmdProxy() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = loadFactoryConfigForRepo(paths.config);
  const settings = resolveEnvironmentProxy(factoryConfig);

  if (!settings.enabled) {
    console.log(
      chalk.yellow(
        'factory proxy: environment.proxy.enabled is false in factory.json — starting anyway (running this command is the explicit opt-in)',
      ),
    );
  }

  const proxy = createLaneProxy({ registryFile: paths.ports, domain: settings.domain, port: settings.port });
  const boundPort = await proxy.start();
  writeProxyState(paths.proxyState, {
    version: 1,
    pid: process.pid,
    port: boundPort,
    domain: settings.domain,
    startedAt: new Date().toISOString(),
  });

  console.log(chalk.green(`factory proxy: listening on 127.0.0.1:${boundPort} (*.${settings.domain})`));
  const leases = readPortLeases(paths.ports);
  if (leases.length === 0) {
    console.log('  no active lane leases yet');
  } else {
    for (const lease of leases) {
      console.log(`  ${laneHostLabel(lease.worktreeId)}.${settings.domain} -> 127.0.0.1:${lease.port}`);
    }
  }
  console.log(
    chalk.dim(
      '  *.localhost resolves to loopback in Chrome/Firefox out of the box (RFC 6761); Safari/curl may need ' +
        'a dnsmasq-backed .test domain instead — documented here, not solved.',
    ),
  );

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      void proxy
        .stop()
        .catch(() => {})
        .then(() => {
          clearProxyState(paths.proxyState);
          resolveShutdown();
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  process.exit(0);
}

/** Runs factoryd in the foreground: a loopback-only HTTP server over the repo
 *  registry (~/.factory/registry.json). Read-only today — GET /repos is the whole
 *  API (#777). Daemon supervision (launchd) is a sibling story; this command is
 *  the process. */
async function cmdFactoryd(opts: { port?: string; registry?: string }) {
  const registryFile = opts.registry ?? defaultRegistryPath();
  const port = opts.port === undefined ? DEFAULT_FACTORYD_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliExitError(`invalid --port "${opts.port}" — expected an integer 0-65535`, 2);
  }

  const daemon = createFactorydServer({ registryFile, port, log: (line) => console.log(chalk.dim(line)) });
  const boundPort = await daemon.start();
  console.log(chalk.green(`factoryd: listening on 127.0.0.1:${boundPort}`));
  console.log(`  registry: ${registryFile}`);
  console.log(`  GET http://127.0.0.1:${boundPort}/repos`);

  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      void daemon
        .stop()
        .catch(() => {})
        .then(() => resolveShutdown());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  process.exit(0);
}

async function cmdRun(opts: { localQueue?: boolean } = {}) {
  if (opts.localQueue === true) {
    throw new CliExitError('factory: --local-queue has been retired; queue issues with GitHub factory:* labels', 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);

  return withRepoRunLock(paths, 'factory run', async () => {
    const ghRepo = await getGitHubRepo();
    const factoryConfig = loadFactoryConfigForRepo(paths.config);
    if (factoryConfig.worktree.autoGcOnRun) {
      try {
        const gcLog = (type: EventKind, msg: string) => logEvent(paths.events, type, '-', msg);
        const report = await withGitLock(repoRoot, () =>
          withFileLock(paths.gitLock, () =>
            sweepWorktrees(
              { repoRoot, ttlDays: factoryConfig.worktree.gcTtlDays, repo: ghRepo },
              { log: gcLog, octokit: getOctokit() },
            ),
          ),
        );
        logEvent(
          paths.events,
          'worktree-gc',
          'all',
          `removed ${report.removed.length} stale worktree(s), kept ${report.kept}`,
        );
        console.log(formatGcReport(report));
      } catch (err: any) {
        logEvent(paths.events, 'warn', 'all', `worktree gc failed: ${err.message}`);
      }
    }

    const { lanes, diagnostics } = await planRunLanes({
      queue: () => {
        const [owner, repo] = ghRepo.split('/');
        const octokit = getOctokit();
        return createGithubQueue({
          client: createOctokitQueueClient(octokit),
          owner,
          repo,
          preflight: (issue) => preflightQueuedIssue(issue, createQueuePreflightOps(octokit, owner, repo)),
        });
      },
    });
    warnQueueDiagnostics(diagnostics);

    const knobs = resolveUsageKnobs(process.env, loadRepoConfig(repoRoot));
    const controller = new AbortController();
    const watchdog = knobs.watch
      ? watchUsage({
          cap: knobs.cap,
          stopAt: knobs.stopAt,
          pollMs: knobs.pollMs,
          stopFile: paths.stop,
          eventsFile: paths.events,
          signal: controller.signal,
          estimator: knobs.estimator,
        }).catch((err: any) => {
          // a watchdog crash must never take down the run
          logEvent(paths.events, 'warn', '-', `usage watchdog crashed: ${err.message}`);
        })
      : Promise.resolve();

    const { proxy } = await startLaneProxy(paths, resolveEnvironmentProxy(factoryConfig));

    try {
      // Run lanes in parallel
      const pids: Promise<void>[] = [];
      for (const planned of lanes) {
        logEvent(
          paths.events,
          'lane-start',
          '-',
          `lane '${planned.lane}' started${planned.issues.length ? ` (${planned.issues.length} issues)` : ''}`,
          { lane: planned.lane },
        );
        pids.push(runLane(planned.lane, planned.issues, repoRoot, ghRepo, paths, planned.deps));
      }

      await Promise.allSettled(pids);
      controller.abort();
      await watchdog;
      logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
    } finally {
      if (proxy) {
        await proxy.stop();
        clearProxyState(paths.proxyState);
      }
    }

    if (lanes.length > 0) {
      try {
        const events = existsSync(paths.events) ? readEvents(paths.events) : [];
        const costs = existsSync(paths.costs) ? readCosts(paths.costs) : [];
        const kpis = computeHealthKpis(events, costs);
        await appendKpiSnapshot(paths, repoRoot, kpis);
        logEvent(paths.events, 'kpi-snapshot', 'all', `KPI snapshot appended to ${paths.kpiHistory}`);
      } catch (err: any) {
        logEvent(paths.events, 'warn', 'all', `kpi snapshot failed: ${err.message}`);
      }
    }
  });
}

/** Wraps cmdRun so an empty queue is a no-op (not a throw) while auto-ingest is enabled and watching. */
export function createSuperviseRunQueue(
  paths: ReturnType<typeof getFactoryPaths>,
  ingestCfg: IngestSettings,
  deps: {
    cmdRunFn?: () => Promise<void>;
    pendingCount?: () => Promise<number>;
    emitEvent?: typeof logEvent;
  } = {},
): () => Promise<void> {
  const { cmdRunFn = cmdRun, pendingCount = async () => 0, emitEvent = logEvent } = deps;
  return async () => {
    if ((await pendingCount()) === 0 && ingestCfg.enabled) {
      emitEvent(paths.events, 'idle', 'auto', 'queue empty — waiting for ready issues');
      return;
    }
    await cmdRunFn();
  };
}

/** Builds the per-cycle auto-ingest hook passed to superviseLoop; failures are logged, never thrown. */
export function createIngestHook(
  repoRoot: string,
  paths: ReturnType<typeof getFactoryPaths>,
  ingestCfg: IngestSettings,
  deps: { runAutoIngestFn?: typeof runAutoIngest; emitEvent?: typeof logEvent } = {},
): () => Promise<number> {
  const { runAutoIngestFn = runAutoIngest, emitEvent = logEvent } = deps;
  return async () => {
    try {
      const result = await runAutoIngestFn({
        repoDir: repoRoot,
        watermarkFile: paths.ingestWatermark,
        label: ingestCfg.label,
        lane: ingestCfg.lane,
        maxPerCycle: ingestCfg.maxPerCycle,
        branchPrefix: resolveBranchPrefix(),
      });
      if (result.appended.length) {
        emitEvent(
          paths.events,
          'ingested',
          'auto',
          `auto-ingest appended ${result.appended.length} ready issue(s): ${result.appended.join(', ')}`,
        );
      }
      return result.appended.length;
    } catch (err) {
      emitEvent(paths.events, 'warn', 'auto', `auto-ingest failed: ${errorDetail(err)}`);
      return 0;
    }
  };
}

async function cmdSupervise(opts: { now?: boolean; localQueue?: boolean }) {
  if (opts.localQueue === true) {
    throw new CliExitError('factory: --local-queue has been retired; queue issues with GitHub factory:* labels', 2);
  }
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const ingestCfg = resolveIngestConfig(loadFactoryConfigForRepo(paths.config));

  const countPending = async (): Promise<number> => {
    const [owner, repo] = (await getGitHubRepo()).split('/');
    const gq = createGithubQueue({ client: createOctokitQueueClient(getOctokit()), owner, repo });
    const lanes = await gq.lanes();
    const counts = await Promise.all(lanes.map((lane) => gq.list(lane)));
    return counts.reduce((total, issues) => total + issues.length, 0);
  };

  if ((await countPending()) === 0 && !ingestCfg.enabled) {
    throw new CliExitError('GitHub queue empty — run factory init + triage first', 2);
  }

  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs(process.env, loadRepoConfig(repoRoot));
  } catch (err: any) {
    throw new CliExitError(`factory: ${err.message}`, 2);
  }

  await withRepoRunLock(paths, 'factory supervise', () =>
    superviseLoop({
      cap: knobs.cap,
      resumeAt: knobs.resumeAt,
      pollMs: knobs.pollMs,
      watch: knobs.watch,
      estimator: knobs.estimator,
      stopFile: paths.stop,
      eventsFile: paths.events,
      now: opts.now,
      runQueue: createSuperviseRunQueue(paths, ingestCfg, {
        cmdRunFn: () => cmdRun(),
        pendingCount: countPending,
      }),
      ingest: ingestCfg.enabled ? createIngestHook(repoRoot, paths, ingestCfg) : undefined,
    }),
  );
}

type RunLaneDeps = {
  ship?: (
    issue: number,
    opts: { product?: string; autoRework?: boolean; interactive?: boolean; approvePlan?: boolean },
    ctx?: { repoRoot: string; ghRepo: string; lane?: string },
  ) => Promise<string>;
  waitMerge?: typeof waitForMerge;
  pathExists?: (path: string) => boolean;
  emitEvent?: typeof logEvent;
  claimNext?: () => Promise<QueueClaim | null>;
  releaseIssue?: (issue: number, outcome: QueueReleaseOutcome) => Promise<void>;
};

export interface PlannedLane {
  lane: string;
  /** Seed issues to work before claiming. Always empty because GitHub labels own scheduling. */
  issues: number[];
  deps: Pick<RunLaneDeps, 'claimNext' | 'releaseIssue'>;
}

export function laneQueueDeps(queue: GithubQueue, lane: string): Pick<RunLaneDeps, 'claimNext' | 'releaseIssue'> {
  return {
    claimNext: () => queue.claimNext(lane),
    releaseIssue: (issue, outcome) => queue.release(issue, outcome),
  };
}

export interface OpenPullRequestEvidence {
  number: number;
  branch: string;
  headSha: string;
  headRepoFullName: string | null;
}

export interface QueuePreflightOps {
  expectedHeadRepoFullName: string;
  findOpenPR(issue: number): Promise<OpenPullRequestEvidence | undefined>;
  getLandState(prNumber: number): ReturnType<typeof getPullRequestLandState>;
  watch(ref: string): Promise<CiOutcome>;
}

export function createQueuePreflightOps(octokit: Octokit, owner: string, repo: string): QueuePreflightOps {
  return {
    expectedHeadRepoFullName: `${owner}/${repo}`,
    findOpenPR: (issue) => findOpenPRForIssue(octokit, owner, repo, issue),
    getLandState: (prNumber) => getPullRequestLandState(octokit, owner, repo, prNumber),
    watch: (ref) => watchChecks({ octokit, owner, repo, ref }),
  };
}

/** Resolve queued work from GitHub evidence without consuming model or worktree resources. */
export async function preflightQueuedIssue(
  issue: QueueIssue,
  deps: QueuePreflightOps,
): Promise<QueuePreflightDecision> {
  if (issue.labels.includes('factory:in-progress')) return { kind: 'defer' };

  let pr: OpenPullRequestEvidence | undefined;
  try {
    pr = await deps.findOpenPR(issue.number);
  } catch (err) {
    return { kind: 'park', reason: `PR lookup failed: ${errorDetail(err)}` };
  }
  if (!pr) return { kind: 'build' };
  if (pr.headRepoFullName !== deps.expectedHeadRepoFullName) {
    return { kind: 'park', reason: `PR #${pr.number} head is not in ${deps.expectedHeadRepoFullName}` };
  }

  let state: Awaited<ReturnType<typeof getPullRequestLandState>>;
  try {
    state = await deps.getLandState(pr.number);
  } catch (err) {
    return { kind: 'park', reason: `PR #${pr.number} merge-state lookup failed: ${errorDetail(err)}` };
  }
  if (state.isDraft !== false) {
    return { kind: 'park', reason: `PR #${pr.number} is draft or its draft state is unavailable` };
  }
  if (!state.mergeStateStatus || state.mergeStateStatus === 'UNKNOWN') {
    return { kind: 'park', reason: `PR #${pr.number} merge state is unavailable` };
  }

  let outcome: CiOutcome;
  try {
    outcome = await deps.watch(pr.headSha);
  } catch (err) {
    return { kind: 'park', reason: `CI watch for PR #${pr.number} failed: ${errorDetail(err)}` };
  }
  if (outcome !== 'success') return { kind: 'park', reason: `CI for PR #${pr.number} ended ${outcome}` };
  return { kind: 'adopt', branch: pr.branch };
}

export async function planRunLanes(input: {
  /** Lazy so the octokit client is only built once the run needs queue state. */
  queue: () => GithubQueue;
}): Promise<{ lanes: PlannedLane[]; diagnostics: QueueDiagnostic[] }> {
  const gq = input.queue();
  const lanes = await gq.lanes();
  return {
    lanes: lanes.map((lane) => ({ lane, issues: [], deps: laneQueueDeps(gq, lane) })),
    diagnostics: [],
  };
}

export async function runLane(
  lane: string,
  issues: number[],
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: RunLaneDeps = {},
) {
  const {
    ship = shipIssue,
    waitMerge = waitForMerge,
    pathExists = existsSync,
    emitEvent = logEvent,
    claimNext = async () => null,
    releaseIssue = async () => {},
  } = deps;
  let merged = 0;
  let awaitingReview = 0;
  let skipped = 0;
  let decomposed = 0;
  const buildClaim = (issue: number): QueueClaim => ({ issue, decision: { kind: 'build' } });
  const pending: QueueClaim[] = issues.map(buildClaim);
  const seen = new Set(issues);
  for (let i = 0; ; i++) {
    if (i >= pending.length) {
      const claimed = await claimNext();
      if (claimed === null) break;
      seen.add(claimed.issue);
      pending.push(claimed);
    }
    const { issue, decision } = pending[i];
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present', { lane });
      await releaseIssue(issue, 'queued');
      return;
    }
    if (decision.kind === 'park') {
      emitEvent(paths.events, 'escalate', issue, decision.reason, { lane });
      emitEvent(
        paths.events,
        'parked',
        issue,
        `lane '${lane}' parked (${decision.reason}); ${pending.length - i - 1} issues remaining`,
        { lane },
      );
      await releaseIssue(issue, 'parked');
      return;
    }
    try {
      const branch = decision.kind === 'adopt' ? decision.branch : await ship(issue, {}, { repoRoot, ghRepo, lane });
      await waitMerge(issue, branch, repoRoot, ghRepo, paths);
      merged++;
      await releaseIssue(issue, 'done');
    } catch (err: any) {
      if (err instanceof AwaitingReviewError) {
        // The land path already emitted the awaiting-review event and cleaned the
        // worktree — this is a clean outcome, not a park; move to the next issue.
        awaitingReview++;
        await releaseIssue(issue, 'done');
        continue;
      }
      if (err instanceof IssueSkippedError) {
        // shipIssue already emitted skipped-already-closed; nothing was attempted.
        skipped++;
        await releaseIssue(issue, 'done');
        continue;
      }
      if (err instanceof IssueDecomposedError) {
        // Continue this lane with newly filed children without touching queue storage.
        const fresh = err.childIssues.filter((n) => !seen.has(n));
        for (const n of fresh) seen.add(n);
        pending.splice(i + 1, 0, ...fresh.map(buildClaim));
        decomposed++;
        emitEvent(
          paths.events,
          'decompose_filed',
          issue,
          `lane '${lane}' continuing with ${fresh.length} child issue(s) in place of #${issue}`,
          { lane },
        );
        await releaseIssue(issue, 'done');
        continue;
      }
      const reason = parkReasonFor(err);
      // Terminal reason events (escalate/timeout/fail/conflict) are emitted exactly
      // once by the layer that detects the failure — shipIssue for pipeline failures,
      // the land path for merge failures. runLane owns only lane-lifecycle events
      // (stopped/parked/lane-done), so injected ship functions never change ownership.
      emitEvent(
        paths.events,
        'parked',
        issue,
        `lane '${lane}' parked (${reason}); ${pending.length - i - 1} issues remaining`,
        { lane },
      );
      await releaseIssue(issue, 'parked');
      return;
    }
  }
  emitEvent(
    paths.events,
    'lane-done',
    lane,
    `lane complete (${merged} merged, ${awaitingReview} awaiting review, ${skipped} skipped, ${decomposed} decomposed)`,
    { lane },
  );
}

export async function isPrMerged(octokit: Octokit, owner: string, repoName: string, branch: string): Promise<boolean> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'all',
    head: `${owner}:${branch}`,
  });
  if (prs.length === 0) return false;
  // Ship-it branch names get reused across separate runs for the same issue
  // (e.g. a "verify-and-close" pass recreates the exact branch name an
  // earlier, already-merged PR used) — GitHub PR numbers only increase, so
  // the highest-numbered PR under this head is always the current one.
  // Checking "was ANY PR ever merged under this branch name" (the old
  // `state: 'closed'` + `.some()` behavior) matched the stale prior PR and
  // falsely reported a brand-new, still-open PR under the same name as
  // merged — waitForMerge then logged "landed" and skipped calling land(),
  // leaving the real PR open forever while the lane believed it was done.
  const latest = prs.reduce((newest: any, pr: any) => (pr.number > newest.number ? pr : newest));
  return Boolean(latest.merged_at);
}

export async function findOpenPRNumber(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
): Promise<number | undefined> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'open',
    head: `${owner}:${branch}`,
  });
  return prs[0]?.number;
}

export async function findOpenPRForIssue(
  octokit: Octokit,
  owner: string,
  repoName: string,
  issueNum: number,
): Promise<OpenPullRequestEvidence | undefined> {
  const perPage = 100;
  const matches = new RegExp(`\\bcloses\\s+#${issueNum}\\b`, 'i');
  for (let page = 1; ; page++) {
    const { data: prs } = await octokit.rest.pulls.list({
      owner,
      repo: repoName,
      state: 'open',
      per_page: perPage,
      page,
    });
    const pr = prs.find((p: any) => matches.test(p.body ?? ''));
    if (pr) {
      const headRepoFullName = pr.head.repo?.full_name ?? null;
      if (headRepoFullName !== `${owner}/${repoName}`) {
        return {
          number: pr.number,
          branch: pr.head.ref,
          headSha: pr.head.sha,
          headRepoFullName,
        };
      }
      return { number: pr.number, branch: pr.head.ref, headSha: pr.head.sha, headRepoFullName };
    }
    if (prs.length < perPage) return undefined;
  }
}

export async function squashMergeAndDelete(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
  prNumber: number,
  opts: { admin?: boolean; run?: CommandRunner } = {},
): Promise<void> {
  if (opts.admin) {
    const run = opts.run ?? exec;
    await run(`gh pr merge ${prNumber} --repo ${shellEscape(`${owner}/${repoName}`)} --admin --squash --delete-branch`);
    return;
  }

  await octokit.rest.pulls.merge({ owner, repo: repoName, pull_number: prNumber, merge_method: 'squash' });
  // Best-effort branch delete: the merge is the source of truth.
  await octokit.rest.git.deleteRef({ owner, repo: repoName, ref: `heads/${branch}` }).catch(() => {});
}

export class LandConflictError extends Error {}

/** The target issue was already resolved before the run started — a clean skip,
 *  not a park. Callers advance to the next queue entry. (#681) */
export class IssueSkippedError extends Error {
  constructor(
    message: string,
    readonly reason: 'already-closed',
  ) {
    super(message);
  }
}

export class AwaitingReviewError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** The target issue tripped the PLAN pre-flight size gate and was decomposed into real
 *  filed sub-issues; the queue was rewritten. Not a park — the lane continues with the
 *  children in place of the oversized issue. (#823) */
export class IssueDecomposedError extends Error {
  constructor(
    message: string,
    readonly childIssues: number[],
  ) {
    super(message);
  }
}

export class LandFailureError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

/** Thrown when watchChecks reports a confirmed CI failure — a completed check run with a
 *  non-passing conclusion. A confirmed failing check must never be merged, admin override
 *  or not. See CiUnverifiedError for the no-verdict case. */
export class CiFailedError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
  ) {
    super(message);
  }
}

/** Thrown when the CI watch never reached a green verdict — a deadline timeout, no check runs ever
 *  registering, or repeated API failures. A subclass of CiFailedError so every existing guard
 *  (parkReasonFor → 'ci-failed', worktree cleanup, cmdLand's exit-0 path) treats "we don't know"
 *  exactly like "we know it's red": never merge. */
export class CiUnverifiedError extends CiFailedError {}

const MAX_MERGE_ATTEMPTS = 5;
const MERGE_RETRY_BASE_MS = 5_000;

export function isReviewRequiredMergeError(
  err: unknown,
  state: { mergeStateStatus?: string; reviewDecision?: string },
): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/approving review/i.test(msg) || /review is required/i.test(msg)) return true;
  return state.mergeStateStatus === 'BLOCKED' && state.reviewDecision === 'REVIEW_REQUIRED';
}

export async function getPullRequestLandState(
  octokit: Octokit,
  owner: string,
  repoName: string,
  prNumber: number,
): Promise<{ id?: string; isDraft?: boolean; mergeStateStatus?: string; reviewDecision?: string }> {
  const result = await octokit.graphql<{
    repository?: {
      pullRequest?: { id?: string; isDraft?: boolean; mergeStateStatus?: string; reviewDecision?: string };
    };
  }>(
    `query PullRequestLandState($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          mergeStateStatus
          reviewDecision
        }
      }
    }`,
    { owner, repo: repoName, number: prNumber },
  );
  return result.repository?.pullRequest ?? {};
}

export async function markPullRequestReady(octokit: Octokit, pullRequestId: string): Promise<void> {
  await octokit.graphql(
    `mutation MarkPullRequestReady($id: ID!) {
      markPullRequestReadyForReview(input: { pullRequestId: $id }) {
        pullRequest { isDraft }
      }
    }`,
    { id: pullRequestId },
  );
}

export async function rebaseDirtyPullRequest(opts: {
  issue: number;
  branch: string;
  worktree: string;
  prNumber: number;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  pathExists?: (path: string) => boolean;
}): Promise<void> {
  const { issue, branch, worktree, prNumber, log, run = exec, pathExists = existsSync } = opts;

  if (!pathExists(worktree)) {
    const msg = `PR #${prNumber} DIRTY on ${branch} and worktree gone`;
    log('conflict', msg);
    throw new LandConflictError(msg);
  }

  try {
    await run('git rebase origin/main', { cwd: worktree });
    await run(`git push --force-with-lease origin ${shellEscape(branch)}`, { cwd: worktree });
  } catch {
    // Best-effort cleanup: the conflict logged below is the error we surface.
    await run('git rebase --abort', { cwd: worktree }).catch(() => {});
    const msg = `rebase conflict on ${branch} — parked`;
    log('conflict', msg);
    throw new LandConflictError(`issue #${issue}: ${msg}`);
  }
}

/** A critical section runner: the land path takes this instead of owning lock composition,
 *  so the locks can be scoped to git mutations and stubbed in tests (#645). */
export type LandLock = <T>(fn: () => Promise<T>) => Promise<T>;

export async function landOpenPullRequest(opts: {
  octokit: Octokit;
  owner: string;
  repoName: string;
  ghRepo: string;
  repoRoot: string;
  issue: number;
  branch: string;
  worktree: string;
  prNumber: number;
  log: (type: EventKind, msg: string) => void;
  run?: CommandRunner;
  pathExists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  skipCI?: boolean;
  adminMerge?: boolean;
  watch?: (opts: WatchChecksOptions) => Promise<CiOutcome>;
  withLock?: LandLock;
  /** Materializes an adopted branch only after its locked state re-read confirms it needs rebasing. */
  ensureWorktree?: () => Promise<void>;
}): Promise<void> {
  const {
    octokit,
    owner,
    repoName,
    issue,
    branch,
    worktree,
    prNumber,
    log,
    run,
    pathExists,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    skipCI = false,
    adminMerge = process.env.FACTORY_MERGE_ADMIN === '1',
    watch = watchChecks,
    withLock = (fn) => fn(),
    ensureWorktree,
  } = opts;

  const watchCi = async () => {
    let outcome: CiOutcome;
    try {
      outcome = await watch({ octokit, owner, repo: repoName, ref: branch });
    } catch (err) {
      const msg = `CI watch for ${branch} failed: ${errorDetail(err)} — refusing to merge without a green verdict`;
      log('ci-failed', msg);
      throw new CiUnverifiedError(msg, prNumber);
    }
    if (outcome === 'success') return;
    if (outcome === 'failure') {
      const msg = `CI failed for PR #${prNumber} on ${branch} — refusing to merge with a failing check`;
      log('ci-failed', msg);
      throw new CiFailedError(msg, prNumber);
    }
    const msg = `CI watch for ${branch} ended ${outcome} — refusing to merge without a green verdict`;
    log('ci-failed', msg);
    throw new CiUnverifiedError(msg, prNumber);
  };

  // The CI watch is a 10-20 minute wait, not a mutation: it must never run under the land
  // locks, or every other lane's setupWorktree serializes behind it (#645).
  if (!skipCI) {
    await watchCi();
  }
  let state = await getPullRequestLandState(octokit, owner, repoName, prNumber);

  if (state.mergeStateStatus === 'DIRTY') {
    const rebased = await withLock(async () => {
      // Re-check under the lock: a sibling lane may have landed (or rebased this branch)
      // while we waited for it, so the DIRTY verdict read above can be stale.
      state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
      if (state.mergeStateStatus !== 'DIRTY') return false;
      await ensureWorktree?.();
      await rebaseDirtyPullRequest({ issue, branch, worktree, prNumber, log, run, pathExists });
      return true;
    });
    if (rebased) {
      if (!skipCI) {
        await watchCi();
      }
      state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
    }
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await withLock(async () => {
        // Same rule as the rebase section: whatever we read before taking the lock (or before
        // the backoff sleep) may be stale, so the attempt decides from a fresh read.
        state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
        if (state.isDraft && state.id) {
          log('land', `PR #${prNumber} still a draft — re-issuing ready-for-review (attempt ${attempt})`);
          await markPullRequestReady(octokit, state.id).catch((err: unknown) =>
            log('warn', `ready-for-review flip failed for PR #${prNumber}: ${errorDetail(err)}`),
          );
        }
        await squashMergeAndDelete(octokit, owner, repoName, branch, prNumber, { admin: adminMerge, run });
      });
      return;
    } catch (err: any) {
      if (isReviewRequiredMergeError(err, state)) {
        log('awaiting-review', `PR #${prNumber} blocked on human review — leaving open for approval`);
        throw new AwaitingReviewError(`PR #${prNumber} awaiting review: ${err.message}`, prNumber);
      }
      if (attempt >= MAX_MERGE_ATTEMPTS) throw err;
      log(
        'land',
        `merge attempt ${attempt}/${MAX_MERGE_ATTEMPTS} failed (${err.message}); mergeStateStatus=${state.mergeStateStatus ?? 'unknown'} — retrying with backoff`,
      );
      // Backoff outside the lock: waiting is not a mutation (#645).
      await sleep(MERGE_RETRY_BASE_MS * 2 ** (attempt - 1));
    }
  }
}

export function issueFromFactoryBranch(branch: string): number | undefined {
  const match = /^ship-it\/(\d+)-/.exec(branch);
  return match ? Number(match[1]) : undefined;
}

export async function listOpenFactoryPRs(
  octokit: Octokit,
  owner: string,
  repoName: string,
): Promise<Array<{ number: number; branch: string; reviewDecision?: string; isDraft?: boolean }>> {
  const prs: Array<{ number: number; branch: string; reviewDecision?: string; isDraft?: boolean }> = [];
  let cursor: string | undefined;

  for (;;) {
    const result = await octokit.graphql<{
      repository?: {
        pullRequests?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: Array<{ number: number; headRefName: string; reviewDecision?: string; isDraft?: boolean }>;
        };
      };
    }>(
      `query OpenFactoryPRs($owner: String!, $repo: String!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequests(states: OPEN, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number headRefName reviewDecision isDraft }
          }
        }
      }`,
      { owner, repo: repoName, cursor },
    );

    const pullRequests = result.repository?.pullRequests;
    for (const node of pullRequests?.nodes ?? []) {
      if (node.headRefName.startsWith('ship-it/')) {
        prs.push({
          number: node.number,
          branch: node.headRefName,
          reviewDecision: node.reviewDecision,
          isDraft: node.isDraft,
        });
      }
    }

    if (!pullRequests?.pageInfo?.hasNextPage) break;
    cursor = pullRequests.pageInfo.endCursor;
  }

  return prs;
}

export interface SweepDeps {
  createOctokit?: () => Octokit;
  loadConfig?: (configPath: string) => FactoryConfig;
  listPRs?: typeof listOpenFactoryPRs;
  land?: typeof landIssue;
  emitEvent?: typeof logEvent;
  writeLine?: (line: string) => void;
}

export async function sweepApprovedPRs(
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: SweepDeps = {},
): Promise<{
  landed: number[];
  skipped: Array<{ pr: number; branch: string; reason: string }>;
  failed: Array<{ pr: number; issue: number; reason: string }>;
}> {
  const {
    createOctokit = getOctokit,
    loadConfig = loadFactoryConfigForRepo,
    listPRs = listOpenFactoryPRs,
    land = landIssue,
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
  } = deps;

  const [owner, repoName] = ghRepo.split('/');
  const octokit = createOctokit();
  const skipCI = resolveSkipCI(loadConfig(paths.config));
  const prs = await listPRs(octokit, owner, repoName);

  const landed: number[] = [];
  const skipped: Array<{ pr: number; branch: string; reason: string }> = [];
  const failed: Array<{ pr: number; issue: number; reason: string }> = [];

  for (const pr of prs) {
    const issue = issueFromFactoryBranch(pr.branch);
    if (issue === undefined) {
      const reason = 'no issue number in branch';
      skipped.push({ pr: pr.number, branch: pr.branch, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) skipped: ${reason}`);
      continue;
    }

    if (pr.reviewDecision !== 'APPROVED') {
      const reason = `not approved (reviewDecision: ${pr.reviewDecision ?? 'none'})`;
      skipped.push({ pr: pr.number, branch: pr.branch, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) skipped: ${reason}`);
      continue;
    }

    try {
      await land(issue, repoRoot, ghRepo, paths, octokit, skipCI);
      landed.push(pr.number);
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) landed for issue #${issue}`);
    } catch (err) {
      const reason = errorDetail(err);
      failed.push({ pr: pr.number, issue, reason });
      writeLine(`[factory] PR #${pr.number} (${pr.branch}) failed to land: ${reason}`);
      continue;
    }
  }

  emitEvent(
    paths.events,
    'resume-approved',
    '-',
    `sweep: ${landed.length} landed, ${skipped.length} skipped, ${failed.length} failed of ${prs.length} open factory PRs`,
  );

  return { landed, skipped, failed };
}

export async function cmdResumeApproved() {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const result = await sweepApprovedPRs(repoRoot, ghRepo, paths);
  console.log(
    chalk.green(
      `✅ resume-approved: ${result.landed.length} landed, ${result.skipped.length} skipped, ${result.failed.length} failed`,
    ),
  );
  if (result.failed.length > 0) {
    throw new CliExitError(`factory: resume-approved: ${result.failed.length} PR(s) failed to land`, 5);
  }
}

/** Consecutive merged-state check failures tolerated before waitForMerge parks the lane.
 *  At the shipped 120s poll that is ~20 minutes of 100% failure (ADR: sustained-failure park). */
export const MERGE_CHECK_MAX_CONSECUTIVE_FAILURES = 10;

/** Wall-clock backstop: continuous merged-state check failure for this long parks the lane even
 *  if fewer than MERGE_CHECK_MAX_CONSECUTIVE_FAILURES attempts were made (slower poll cadence). */
export const MERGE_CHECK_FAILURE_BUDGET_MS = 2 * 60 * 60 * 1000;

/** GitHub signals both primary and secondary rate limits with 403 — the same status it uses for a
 *  token that genuinely lacks the scope. Only a 403 with no rate-limit evidence is permanent. */
function looksRateLimited(err: unknown): boolean {
  const headers = (err as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers ?? {};
  const remaining = headers['x-ratelimit-remaining'];
  if (typeof remaining === 'string' && remaining.trim() === '0') return true;
  if (typeof remaining === 'number' && remaining === 0) return true;
  if (headers['retry-after'] !== undefined) return true;
  return /rate limit|secondary rate|abuse detection/i.test(errorDetail(err));
}

/** True when a merged-state check failure cannot recover by retrying: an expired/revoked token
 *  (401) or a token missing `pulls:read` (403 with no rate-limit evidence). */
export function isPermanentMergeCheckError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401) return true;
  if (status !== 403) return false;
  return !looksRateLimited(err);
}

type WaitForMergeDeps = {
  createOctokit?: () => Octokit;
  pathExists?: (path: string) => boolean;
  checkMerged?: typeof isPrMerged;
  loadConfig?: (configPath: string) => FactoryConfig;
  land?: (
    issueNum: number,
    repoRoot: string,
    ghRepo: string,
    paths: ReturnType<typeof getFactoryPaths>,
    octokit: Octokit,
  ) => Promise<{ branch: string; prNumber: number }>;
  listIssueLabels?: (octokit: Octokit, owner: string, repo: string, issue: number) => Promise<string[]>;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  mergeEnabled?: () => boolean;
  writeLine?: (line: string) => void;
  /** Injectable clock so the wall-clock failure budget is testable. Default `() => Date.now()`. */
  now?: () => number;
};

async function defaultListIssueLabels(octokit: Octokit, owner: string, repo: string, issue: number): Promise<string[]> {
  const { data } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number: issue });
  return data.map((label) => label.name);
}

export async function waitForMerge(
  issue: number,
  branch: string,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: WaitForMergeDeps = {},
): Promise<void> {
  const {
    createOctokit = getOctokit,
    pathExists = existsSync,
    checkMerged = isPrMerged,
    loadConfig = loadFactoryConfigForRepo,
    land = landIssue,
    listIssueLabels = defaultListIssueLabels,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    mergeEnabled,
    writeLine = (line) => console.log(line),
    now = () => Date.now(),
  } = deps;
  const factoryConfig = loadConfig(paths.config);
  const isMergeEnabled = mergeEnabled ?? (() => factoryConfig.merge.auto || process.env.FACTORY_MERGE === '1');
  const skipCI = resolveSkipCI(factoryConfig);
  const filingPolicy = resolveFilingPolicy(factoryConfig);
  const octokit = createOctokit();
  const [owner, repoName] = ghRepo.split('/');

  emitEvent(paths.events, 'await-merge', issue, `waiting to merge ${branch}`);
  let consecutiveFailures = 0;
  let firstFailureAt: number | null = null;
  while (!pathExists(paths.stop)) {
    let merged = false;
    try {
      merged = await checkMerged(octokit, owner, repoName, branch);
      consecutiveFailures = 0;
      firstFailureAt = null;
    } catch (err) {
      consecutiveFailures++;
      firstFailureAt ??= now();
      const detail = errorDetail(err);
      emitEvent(paths.events, 'warn', issue, `merged-state check failed (treating as not merged): ${detail}`);

      const permanent = isPermanentMergeCheckError(err);
      const elapsedMs = now() - firstFailureAt;
      const budgetSpent = elapsedMs >= MERGE_CHECK_FAILURE_BUDGET_MS;
      const streakSpent = consecutiveFailures >= MERGE_CHECK_MAX_CONSECUTIVE_FAILURES;
      if (permanent || streakSpent || budgetSpent) {
        const trigger = permanent
          ? 'permanent error (auth/scope — retrying cannot help)'
          : `${consecutiveFailures} consecutive failures over ${Math.round(elapsedMs / 1000)}s`;
        const msg = `merged-state check for ${branch} is not recovering — parking lane after ${trigger}: ${detail}`;
        emitEvent(paths.events, 'escalate', issue, msg);
        throw new LaneParkError(msg, 'escalate');
      }
    }
    if (merged) {
      emitEvent(paths.events, 'landed', issue, 'PR merged');
      return;
    }

    if (isMergeEnabled()) {
      let labels: string[] = [];
      try {
        labels = await listIssueLabels(octokit, owner, repoName, issue);
      } catch (err) {
        emitEvent(paths.events, 'warn', issue, `label check failed (treating as blocked): ${errorDetail(err)}`);
        labels = [filingPolicy.selfFixLabel];
      }
      if (isAutoMergeBlocked(labels, filingPolicy)) {
        emitEvent(
          paths.events,
          'merge-gated',
          issue,
          `auto-merge blocked by ${filingPolicy.selfFixLabel} — awaiting human approval`,
        );
        writeLine(
          `[factory] #${issue} auto-merge gated (${filingPolicy.selfFixLabel}); awaiting human merge (poll 120s)`,
        );
        await sleep(120_000);
        continue;
      }
      await land(issue, repoRoot, ghRepo, paths, octokit, skipCI);
      return;
    }

    writeLine(`[factory] #${issue} awaiting human merge (poll 120s)`);
    await sleep(120_000);
  }
}

export interface SuperviseDeps {
  cap: number;
  resumeAt: number;
  pollMs: number;
  watch?: boolean;
  estimator?: boolean;
  stopFile: string;
  eventsFile: string;
  now?: boolean;
  runQueue: () => Promise<void>;
  readUsageFn?: () => Promise<UsageReading | null>;
  pathExists?: (path: string) => boolean;
  clearStop?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  writeLine?: (line: string) => void;
  /** When set, run once per cycle before draining the queue; returns count appended. Its presence
   *  also switches the loop into perpetual-poll mode (see superviseLoop). */
  ingest?: () => Promise<number>;
}

const USAGE_UNAVAILABLE_LINE =
  '[factory] supervise: usage signal unavailable — proceeding without resume gate (set FACTORY_USAGE_ESTIMATOR=1 to gate on the heuristic)';

export async function superviseLoop(deps: SuperviseDeps): Promise<void> {
  const {
    cap,
    resumeAt,
    pollMs,
    watch = true,
    estimator = false,
    stopFile,
    eventsFile,
    now,
    runQueue,
    readUsageFn = () => readUsage({ cap, estimator }),
    pathExists = existsSync,
    clearStop = (path: string) => rmSync(path, { force: true }),
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
    ingest,
  } = deps;

  let cycle = 0;
  while (true) {
    cycle++;
    let pct = 0;
    let source = 'unavailable';

    if (!watch) {
      writeLine('[factory] supervise: usage watchdog disabled (FACTORY_USAGE_WATCH=0) — skipping resume gate');
    } else {
      let reading = await readUsageFn();
      if (reading === null) {
        writeLine(USAGE_UNAVAILABLE_LINE);
      } else {
        pct = reading.pct;
        source = reading.source;
        if (cycle > 1 || !now) {
          while (pct >= resumeAt) {
            writeLine(
              `[factory] supervise: trailing usage (${source}) ${Math.round(pct * 100)}% >= resume gate ${Math.round(resumeAt * 100)}% — waiting ${pollMs / 1000}s`,
            );
            await sleep(pollMs);
            reading = await readUsageFn();
            if (reading === null) {
              writeLine(USAGE_UNAVAILABLE_LINE);
              pct = 0;
              source = 'unavailable';
              break;
            }
            pct = reading.pct;
            source = reading.source;
          }
        }
      }
    }

    emitEvent(
      eventsFile,
      'resumed',
      'usage',
      `supervise cycle ${cycle}: trailing usage (${source}) at ${Math.round(pct * 100)}% of cap — starting run`,
    );
    clearStop(stopFile);
    if (ingest) {
      const appended = await ingest();
      if (appended > 0) writeLine(`[factory] supervise: auto-ingest appended ${appended} ready issue(s)`);
    }
    await runQueue();
    if (pathExists(stopFile)) continue;
    if (ingest) {
      await sleep(pollMs);
      continue;
    }
    break;
  }
  emitEvent(eventsFile, 'supervisor-done', 'usage', 'supervise finished — queue drained or lanes need attention');
}

export function getCliVersion(): string {
  return createRequire(import.meta.url)('../../package.json').version;
}

function toLeaseRow(health: LeaseHealth): LeaseHealthRow {
  return {
    worktreeId: health.lease.worktreeId,
    branch: health.lease.branch,
    port: health.lease.port,
    pid: health.lease.pid,
    alive: health.alive,
    reason: health.reason,
    portSquatted: health.portSquatted,
  };
}

async function cmdDoctor(opts: { reconcile?: boolean } = {}) {
  const checks = runDoctorChecks({
    commandAvailable: isCommandAvailable,
    envPresent: (key) => !!process.env[key],
    tryExec: (cmd) => {
      try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        return null;
      }
    },
    pathExists: existsSync,
    distFreshness: distFreshnessProbe(import.meta.url),
  });

  let repoRoot: string | null;
  try {
    repoRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    repoRoot = null;
  }

  if (repoRoot !== null) {
    const paths = getFactoryPaths(repoRoot);
    const health = await inspectPortLeases({ registryFile: paths.ports });
    checks.push(...leaseChecks(health.map(toLeaseRow)));

    const eventsContent = existsSync(paths.events) ? readFileSync(paths.events, 'utf-8') : null;
    checks.push(eventLogCheck(eventsContent === null ? null : analyzeEventLog(eventsContent)));

    if (opts.reconcile) {
      const reaped = await reapStalePortLeases({ registryFile: paths.ports, lockDir: paths.portsLock });
      console.log(formatReconcileReport(reaped));

      if (reaped.length > 0) {
        const graceMs = resolveProcessGroupGraceMs(loadFactoryConfigForRepo(paths.config));
        const orphanEvents = await reapOrphanProcesses({ reaped, graceMs });
        for (const e of orphanEvents) {
          console.log(
            `reconcile: ${e.action === 'killed' ? 'killed' : 'found'} pid ${e.pid} (pgid ${e.pgid}, ${e.command}) squatting port ${e.port} of dead lane ${e.worktreeId}${e.action === 'reported' ? ' — not factory-started, left running' : ''}`,
          );
        }
      }
    }
  }

  console.log(formatDoctorChecks(checks));
  if (doctorFailed(checks)) process.exit(1);
}

// ---------- main ----------

export async function main() {
  if (process.argv.slice(2).length === 0) {
    console.log(formatOverview());
    return;
  }

  const staleExit = runStalenessGuard({
    entryUrl: import.meta.url,
    env: process.env,
    argv: process.argv,
    error: (m) => console.error(chalk.red(m)),
    warn: (m) => console.error(chalk.yellow(m)),
  });
  if (staleExit !== null) {
    process.exitCode = staleExit;
    return;
  }

  const program = new Command();

  program
    .name('factory')
    .description('Multi-agent software factory with boss-worker-checker orchestration')
    .version(getCliVersion())
    .addHelpText('before', PREREQUISITES_TEXT);

  program.command('init').description('Initialize .factory in this repo').action(cmdInit);

  program
    .command('constitution')
    .description('Manage product constitutions')
    .option('--init <product>', 'Scaffold a new constitution from the template')
    .option('--list', 'List available constitutions')
    .option('--product <name>', 'Set active product constitution')
    .action(cmdConstitution);

  program
    .command('models')
    .description('List available models and costs')
    .option('--doctor', 'Probe provider CLIs and env keys; report per-model reachability')
    .action(cmdModels);

  program
    .command('doctor')
    .description('Preflight-check your environment (claude, gh, token, git, npm, sandbox)')
    .option('--reconcile', 'Remove stale port leases and report freed ports')
    .action((opts: { reconcile?: boolean }) => cmdDoctor(opts));

  program
    .command('cost')
    .description('Show cost tracking summary')
    .option('--issue <number>', 'show per-entry detail for one issue')
    .action((opts: { issue?: string }) => cmdCost(opts));

  program
    .command('usage')
    .description('Report real 5h subscription usage (with a list-price heuristic fallback)')
    .action(cmdUsage);

  program.command('status').description('Show queue, events, PRs, models').action(cmdStatus);

  program.command('kpis').description('Compute factory health KPIs and record a trend snapshot').action(cmdKpis);

  program.command('tui').description('Live read-only view of the current run (q to quit)').action(cmdTui);

  program
    .command('logs')
    .description('Print pipeline events from .factory/events.ndjson (--follow to tail)')
    .option('--follow', 'Keep watching for new events')
    .option('--json', 'Emit one JSON object per line')
    .option('--issue <number>', 'Only show events for this issue')
    .action(async (opts: { follow?: boolean; json?: boolean; issue?: string }) => {
      const repoRoot = await getRepoRoot();
      const paths = getFactoryPaths(repoRoot);
      await cmdLogs(opts, { eventsFile: paths.events });
    });

  const triage = program
    .command('triage')
    .description('Propose a queue from open issues')
    .option('--product <name>', 'Product constitution to scope triage')
    .action(cmdTriage);

  triage
    .command('accept')
    .description('Validate .factory/queue.proposed and apply GitHub queue labels')
    .option('--force', 'Skip validation and apply labels as-is')
    .action(async (opts) => {
      await cmdTriageAccept(opts);
    });

  program
    .command('ready <issue>')
    .description('Score an issue against the factory-ready template fields (pass/fail, names missing fields)')
    .action(cmdReady);

  program
    .command('ship <issue>')
    .description('Plan → build → check → ship one issue')
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .action(async (issueNum, opts) => {
      await cmdShip(parseIssueArg(issueNum), opts);
    });

  program
    .command('run-issue <issue>')
    .description(
      'One-shot: resolve one GitHub issue through the canonical work-request seam and run plan → build → check → ship (queue untouched)',
    )
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .action(async (issueNum, opts) => {
      await cmdRunIssue(parseIssueArg(issueNum), opts);
    });

  program
    .command('run-brief <file>')
    .description(
      'One-shot: resolve a local Markdown brief through the canonical work-request seam and run plan → build → check → ship (queue untouched)',
    )
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .option('--interactive', 'Pause before opening the PR and wait for approval from the TUI')
    .option('--approve-plan', 'Pause after PLAN freezes the spec and wait for approval before BUILD')
    .option('--no-sandbox', 'Disable the containment sandbox for agent runs (dangerous)')
    .option(
      '--workspace <dir>',
      'Local-only: run PLAN/BUILD/CHECK in this caller-provided git workspace and disable PR creation, merging, queue polling, and GitHub mutations',
    )
    .option(
      '--artifacts <dir>',
      'Local-only: write a versioned benchmark artifact manifest (manifest.json, request.json, events.ndjson, diff.patch) to this directory; requires --workspace',
    )
    .action(async (file, opts) => {
      await cmdRunBrief(file, opts);
    });

  program
    .command('local-small-dry-run <issue>')
    .description('Create a bounded local-small step plan and first context pack without changing source files')
    .option('--spec <path>', 'Frozen spec path; defaults to .factory/plans/issue-<n>.md')
    .option('--output <path>', 'Artifact directory; defaults to .factory/local-small/issue-<n>')
    .action(async (issueNum, opts) => {
      await cmdLocalSmallDryRun(parseIssueArg(issueNum), opts);
    });

  program
    .command('local-small-overnight')
    .description(
      'Process a curated local-small queue one issue at a time: review-only PRs, never merges, parks on ambiguity',
    )
    .option('--queue <path>', 'Curated queue file; defaults to .factory/local-small/overnight-queue')
    .option('--state <path>', 'Resume-state file; defaults to .factory/local-small/overnight-state.json')
    .action(async (opts) => {
      await cmdLocalSmallOvernight(opts);
    });

  program
    .command('land <issue>')
    .description('Squash-merge a ready PR and clean up its worktree')
    .action(async (issueNum) => {
      await cmdLand(parseIssueArg(issueNum));
    });

  program
    .command('resume-approved')
    .description('Land open factory PRs (ship-it/*) whose review is now approved; skip the rest')
    .action(async () => {
      await cmdResumeApproved();
    });

  program
    .command('run')
    .description('Process the whole queue (lanes in parallel)')
    .option('--local-queue', 'Retired: GitHub issue labels are now the only supported queue')
    .action((opts: { localQueue?: boolean }) => cmdRun(opts));

  program
    .command('proxy')
    .description(
      'Run the opt-in lane reverse proxy in the foreground (manual use; `factory run`/`supervise` host it in-process)',
    )
    .action(cmdProxy);

  program
    .command('daemon')
    .description('Run factoryd in the foreground: a localhost-only HTTP API over the repo registry')
    .option('--port <n>', `port to bind on 127.0.0.1 (default ${DEFAULT_FACTORYD_PORT})`)
    .option('--registry <file>', 'registry file to serve (default ~/.factory/registry.json)')
    .action((opts: { port?: string; registry?: string }) => cmdFactoryd(opts));

  const worktreeCmd = program.command('worktree').description('Worktree maintenance');
  worktreeCmd
    .command('gc')
    .description('Remove stale factory worktrees (merged/closed branches or older than TTL) and scrub credentials')
    .option('--dry-run', 'Preview what would be removed without deleting anything')
    .option('--ttl-days <n>', 'Override worktree.gcTtlDays from factory.json')
    .action(cmdWorktreeGc);

  program
    .command('supervise')
    .description('Multi-window loop: wait for usage headroom, run the queue, repeat until drained')
    .option('--now', 'Skip the initial headroom wait')
    .option('--local-queue', 'Retired: GitHub issue labels are now the only supported queue')
    .action(async (opts) => {
      await cmdSupervise(opts);
    });

  program
    .command('stop')
    .description('Halt between issues')
    .action(async () => {
      const repoRoot = await getRepoRoot();
      const paths = getFactoryPaths(repoRoot);
      writeFileSync(paths.stop, '');
      console.log('STOP set — lanes halt between issues');
    });

  program
    .command('resume')
    .description('Resume after stop')
    .action(async () => {
      const repoRoot = await getRepoRoot();
      const paths = getFactoryPaths(repoRoot);
      if (existsSync(paths.stop)) {
        await import('node:fs/promises').then((fs) => fs.unlink(paths.stop));
      }
      console.log('STOP cleared');
    });

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CliExitError) {
      console.error(chalk.red(err.message));
      process.exitCode = err.code;
      return;
    }
    throw err;
  }
}
