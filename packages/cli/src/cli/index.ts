// packages/cli/src/cli/index.ts — CLI entry point: factory <command> [options]

import { exec as execCb, execSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Octokit } from '@octokit/rest';
import type {
  FailoverReason,
  IngestSettings,
  LeaseHealth,
  ModelDiagnosis,
  QueueDiagnostic,
  RepoFactoryConfig,
  SandboxPolicy,
  UsageReading,
} from '@on-par/factory-core';
import {
  acquirePortLease,
  appendKpiHistoryLine,
  applyRepoConfig,
  buildPhase,
  checkPhase,
  computeHealthKpis,
  ConstitutionLoader,
  createFileApprovalGate,
  describeEffectiveConfig,
  describeSteering,
  diagnoseModels,
  drainSteering,
  estimateTrailingSpend,
  fetchSubscriptionUsage,
  formatKpiLines,
  formatUsageReport,
  gateBuildOnBreaker,
  getConstitutionsDir,
  getFactoryPaths,
  inspectPortLeases,
  isCommandAvailable,
  kpisToHistoryRecord,
  listQueuedSteering,
  loadFactoryConfig,
  loadModelsConfig,
  loadRepoConfig,
  loadRoutesConfig,
  ModelRegistry,
  ModelRouter,
  parseKpiHistory,
  parseQueue,
  planPhase,
  ProviderBreaker,
  readEvents,
  readUsage,
  reapStalePortLeases,
  releasePortLease,
  renderKpiReport,
  renderKpiTrend,
  resolveAutoFailover,
  resolveCodexDisabled,
  resolveEffectiveModelPins,
  resolveEnvironmentPorts,
  resolveIngestConfig,
  resolvePlanApproval,
  resolveSandboxPolicy,
  resolveSkipCI,
  resolveTimeouts,
  resolveUsageCap,
  runAutoIngest,
  shipPhase,
  validateQueue,
  watchUsage,
  writeLocalRunReport,
} from '@on-par/factory-core';
import type {
  OvernightItemOutcome,
  OvernightPreflightResult,
  OvernightQueueDeps,
  OvernightStateItem,
} from '@on-par/factory-core/internal';
import {
  branchFor,
  branchPrefixSlug,
  cleanupWorktree,
  createLocalSmallDryRun,
  ensureDir,
  formatGcReport,
  gitFetch,
  isAutoMergeBlocked,
  logCost,
  logEvent,
  readCosts,
  resolveFilingPolicy,
  runOvernightQueue,
  setupWorktree,
  shellEscape,
  sweepWorktrees,
  watchChecks,
  withFileLock,
  withGitLock,
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
  return new Octokit({ auth: token });
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

  // Create sample queue if not exists
  if (!existsSync(paths.queue)) {
    writeFileSync(
      paths.queue,
      `# factory queue — "<lane> <issue#>", priority-ordered.
# Lanes run in parallel; issues within a lane run serially.
# Put issues that touch the same files in the same lane.
# Example:
#   app 61
#   docs 66
`,
    );
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
  const allowExperimental = process.env.FACTORY_EXPERIMENTAL === '1';
  const localOnly = process.env.FACTORY_LOCAL_ONLY === '1';

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

async function cmdKpis() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const events = existsSync(paths.events) ? readEvents(paths.events) : [];
  const costs = existsSync(paths.costs) ? readCosts(paths.costs) : [];
  const kpis = computeHealthKpis(events, costs);

  const record = kpisToHistoryRecord(kpis, new Date().toISOString().slice(0, 10));
  const existing = existsSync(paths.kpiHistory) ? readFileSync(paths.kpiHistory, 'utf-8') : '';
  writeFileSync(paths.kpiHistory, appendKpiHistoryLine(existing, record));

  console.log(renderKpiReport(kpis));
  console.log(renderKpiTrend(parseKpiHistory(readFileSync(paths.kpiHistory, 'utf-8'))));
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
  const router = new ModelRouter(modelsConfig, routesConfig);
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
  if (existsSync(paths.queue)) {
    const { entries, diagnostics } = parseQueue(readFileSync(paths.queue, 'utf-8'));
    if (entries.length > 0) {
      for (const e of entries) console.log(`  ${e.lane} ${e.issue}`);
    } else if (diagnostics.length === 0) {
      console.log('  (empty)');
    }
    warnQueueDiagnostics(diagnostics);
  } else {
    console.log('  (no queue file)');
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
    queueFile: paths.queue,
    queueProposedFile: paths.queueProposed,
    costsFile: paths.costs,
    approvalsDir: paths.approvals,
    steeringDir: paths.steering,
  });
}

export type ParkReason = 'escalate' | 'timeout' | 'fail' | 'conflict';

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
  if ((err as any)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

export async function shipIssue(
  issueNum: number,
  opts: { product?: string; autoRework?: boolean; interactive?: boolean; sandbox?: boolean; approvePlan?: boolean },
  ctx?: { repoRoot: string; ghRepo: string; lane?: string },
) {
  const repoRoot = ctx?.repoRoot ?? (await getRepoRoot());
  const ghRepo = ctx?.ghRepo ?? (await getGitHubRepo());
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();

  const repoConfig = loadRepoConfig(repoRoot);
  const modelsConfig = applyRepoConfig(loadModelsConfig(), repoConfig);
  const routesConfig = loadRoutesConfig();
  const factoryConfig = loadFactoryConfig();
  const timeouts = resolveTimeouts(factoryConfig);
  const failoverSettings = resolveAutoFailover(factoryConfig);
  const breaker = new ProviderBreaker(paths.breaker);
  const router = new ModelRouter(modelsConfig, routesConfig);
  router.setCostSink((entry) => logCost(paths.costs, { ...entry, issue: String(issueNum) }));
  const modelPins = resolveEffectiveModelPins(router.registryRef, repoConfig);
  const codexOff = resolveCodexDisabled(repoConfig);
  const constitutionLoader = new ConstitutionLoader();

  const product = opts.product ?? readActiveProduct(paths.product);
  const autoRework = opts.autoRework ?? true;

  const issueTitle = await getIssueTitle(octokit, ghRepo, issueNum);
  const branch = branchFor(issueNum, issueTitle);
  const worktree = worktreePathFor(repoRoot, issueNum);
  const specPath = resolve(paths.plans, `issue-${issueNum}.md`);
  const runStartedAt = new Date().toISOString();
  let route: 'codex' | 'claude' | undefined;

  const lane = ctx?.lane;
  const mkLog = (phase?: string) => (type: string, msg: string, extra?: { failoverReason?: FailoverReason }) =>
    logEvent(paths.events, type, issueNum, msg, { ...extra, lane, phase });
  const log = mkLog();
  log('issue-title', issueTitle);
  if (modelPins.plan) {
    const source = modelPins.sources.plan === 'repo' ? '.factory/config.json' : 'FACTORY_PLAN_MODEL';
    log('model-override', `plan model pinned to ${modelPins.plan} (${source})`);
  }
  if (modelPins.build) {
    const source = modelPins.sources.build === 'repo' ? '.factory/config.json' : 'FACTORY_BUILD_MODEL';
    log('model-override', `build model pinned to ${modelPins.build} (${source})`);
  }

  // Setup worktree FIRST — plan phase needs cwd=worktree to run claude
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
  log('worktree', `Worktree ready at ${worktree}`);

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

  const portsSettings = resolveEnvironmentPorts(factoryConfig);
  let appPort: number | undefined;
  if (portsSettings.enabled) {
    try {
      const lease = await acquirePortLease({
        registryFile: paths.ports,
        lockDir: paths.portsLock,
        worktreeId: worktree,
        branch,
        range: portsSettings.range,
        onReap: (r) =>
          log(
            'environment_lease_reaped',
            `reaped stale lease: port ${r.lease.port}, pid ${r.lease.pid}, worktree ${r.lease.worktreeId} — reason: ${r.reason}`,
          ),
      });
      appPort = lease.port;
      log('environment_lease', `leased port ${lease.port} for worktree ${worktree}`);
    } catch (err: any) {
      // Port collision is no worse than today — never park a lane over a lease.
      log('environment_lease_failed', `port lease unavailable (${err.message}) — running without injected PORT`);
    }
  } else {
    log('environment_lease', 'port leasing disabled (environment.ports.enabled=false or FACTORY_ENV_PORTS=0)');
  }

  try {
    // PLAN
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
      modelOverride: modelPins.plan,
      branch,
      approvalGate: planApprovalEnabled
        ? createFileApprovalGate({ dir: paths.approvals, timeoutMs: timeouts.approval * 1000 })
        : undefined,
      drainSteering: planApprovalEnabled ? () => drainSteering(paths.steering, issueNum, worktree) : undefined,
      codexDisabled: codexOff,
    });
    route = plan.route;
    if (!plan.ok) {
      throw new LaneParkError(`plan escalated: ${plan.escalate ?? 'unknown'}`, 'escalate');
    }

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

    const build = await buildPhase({
      issue: issueNum,
      repo: ghRepo,
      worktree,
      specPath,
      branch,
      constitution,
      route: plan.route,
      router,
      log: mkLog('build'),
      timeoutSeconds: timeouts.build,
      skipCI,
      modelOverride: modelPins.build,
      sandbox: activeSandboxPolicy,
      steering: buildSteering,
      appPort,
      codexDisabled: codexOff || breakerBlocked,
      autoFailover: {
        enabled: failoverSettings.enabled,
        fallbackModel: failoverSettings.fallbackModel,
        onQuotaExhausted: async ({ provider, reason }) => {
          await breaker.open(provider, reason, failoverSettings.cooldownMs);
          // No failoverReason metadata here: the build's own worker_failover
          // event already carries it for this same quota trip, and KPI retry
          // counting (retryCauseOf) treats any failoverReason-bearing event as
          // a distinct retry — attaching it here would double-count one retry.
          mkLog('build')(
            'provider_breaker_open',
            `breaker opened for ${provider} (${reason}) — cooldown ${Math.round(failoverSettings.cooldownMs / 60_000)}m`,
          );
        },
      },
    });
    if (!build.ok) {
      throw new LaneParkError(`build escalated: ${build.escalate ?? 'unknown'}`, 'escalate');
    }

    // CHECK
    const check = await checkPhase({
      issue: issueNum,
      worktree,
      specPath,
      constitution,
      router,
      log: mkLog('check'),
      autoRework,
      buildTimeoutSeconds: timeouts.build,
      checkTimeoutSeconds: timeouts.check,
      sandbox: activeSandboxPolicy,
      drainSteering: opts.interactive ? () => drainSteering(paths.steering, issueNum, worktree) : undefined,
      appPort,
    });
    for (const s of check.summary.results.filter((r) => r.result === 'SKIP')) {
      console.error(chalk.yellow(`  SKIP: ${s.checker} — ${s.details}`));
    }
    if (!check.passed) {
      const failures = check.summary.results.filter((r) => r.result === 'FAIL');
      for (const f of failures) {
        console.error(chalk.red(`  FAIL: ${f.checker} — ${f.details}`));
      }
      throw new LaneParkError(
        check.stuck
          ? `lane stuck after ${check.reworkRounds} rework rounds (identical failures) — escalated`
          : `${check.summary.failures} check failures after ${check.reworkRounds} rework rounds`,
        check.stuck ? 'escalate' : 'fail',
      );
    }

    // SHIP
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

    log('ready', `PR #${ship.prNumber} ready for review`);
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
    console.log(chalk.green(`✅ Issue #${issueNum} → PR #${ship.prNumber} ready for review`));
    return branch;
  } catch (err: any) {
    log(parkReasonFor(err), err.message);
    await maybeWriteLocalRunReport({
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
    throw err;
  } finally {
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
}) {
  if (process.env.FACTORY_LOCAL_ONLY !== '1') return;
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
  try {
    return await shipIssue(issueNum, opts);
  } catch (err: any) {
    throw new CliExitError(`Ship failed for issue #${issueNum}: ${err.message}`, 1);
  }
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
  const ghRepo = await getGitHubRepo();
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

  process.env.FACTORY_LOCAL_ONLY = '1';

  const preflight = async (): Promise<OvernightPreflightResult> => {
    if (!isCommandAvailable('claude')) return { ok: false, reason: missingClaudeCliMessage() };
    const registry = new ModelRegistry(applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot)));
    const ollamaModels = ollamaModelSet();
    const diagnoses = diagnoseModels(
      registry,
      { ollamaModelPresent: ollamaModels ? (m: string) => ollamaModels.has(m) : undefined },
      process.env.FACTORY_EXPERIMENTAL === '1',
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
  const log = (type: string, msg: string) => logEvent(paths.events, type, '-', msg);

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
}

async function getIssueTitle(octokit: Octokit, repo: string, issue: number): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
  return data.title;
}

function worktreePathFor(repoRoot: string, issueNum: number): string {
  return resolve(dirname(repoRoot), `${basename(repoRoot)}-factory-${branchPrefixSlug()}-${issueNum}`);
}

export async function cmdWorktreeGc(opts: { dryRun?: boolean; ttlDays?: string }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const factoryConfig = loadFactoryConfig();
  const ttlDays = opts.ttlDays !== undefined ? Number(opts.ttlDays) : factoryConfig.worktree.gcTtlDays;
  if (!Number.isFinite(ttlDays) || ttlDays < 0) {
    throw new CliExitError('factory: --ttl-days must be a non-negative number', 2);
  }
  const log = (type: string, msg: string) => logEvent(paths.events, type, '-', msg);
  const run = () => sweepWorktrees({ repoRoot, ttlDays, dryRun: opts.dryRun }, { log });
  const report = opts.dryRun ? await run() : await withGitLock(repoRoot, () => withFileLock(paths.gitLock, run));
  console.log(formatGcReport(report));
}

export async function cmdLand(issueNum: number) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();
  const factoryConfig = loadFactoryConfig();
  const skipCI = resolveSkipCI(factoryConfig);

  try {
    const result = await landIssue(issueNum, repoRoot, ghRepo, paths, octokit, skipCI);
    console.log(chalk.green(`✅ Landed PR #${result.prNumber} for issue #${issueNum}`));
  } catch (err: any) {
    if (err instanceof AwaitingReviewError) {
      console.log(chalk.yellow(`⏸ PR #${err.prNumber} for issue #${issueNum} awaiting human review — left open`));
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
  const log = (type: string, msg: string, extra?: { failoverReason?: FailoverReason }) =>
    logEvent(paths.events, type, issueNum, msg, extra);

  // The issue title may have been edited since the PR was opened, so a
  // freshly-derived branch name can drift from the branch the PR actually
  // lives on (same failure mode fixed for waitForMerge in #51). Guess the
  // branch from the current title first, but fall back to matching the open
  // PR that references this issue directly and use its real head branch.
  const guessedBranch = branchFor(issueNum, await getIssueTitle(octokit, ghRepo, issueNum));
  const worktree = worktreePathFor(repoRoot, issueNum);

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

  try {
    await withGitLock(repoRoot, () =>
      withFileLock(
        paths.mergeLock,
        async () => {
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
            });
          } catch (err) {
            if (err instanceof AwaitingReviewError) {
              await cleanupWorktree(repoRoot, worktree, log);
            }
            throw err;
          }
          log('merged', `squash-merged PR #${prNumber}`);
          await cleanupWorktree(repoRoot, worktree, log);
        },
        { onSteal: (pid) => log('lock-stolen', `stole ${paths.mergeLock} from dead holder pid ${pid ?? 'unknown'}`) },
      ),
    );
  } catch (err: any) {
    if (err instanceof LandConflictError || err instanceof AwaitingReviewError) throw err;
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

  const modelsConfig = applyRepoConfig(loadModelsConfig(), loadRepoConfig(repoRoot));
  const routesConfig = loadRoutesConfig();
  const router = new ModelRouter(modelsConfig, routesConfig);
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
  const message = triageProposalMessage(proposed, paths.queueProposed, paths.queue);
  if (message) {
    console.log(message);
  } else {
    throw triageNoProposalError(plannerError);
  }
}

export function triageProposalMessage(proposed: string, proposedPath: string, queuePath: string): string | null {
  if (!proposed.trim()) return null;
  return `${proposed}\n---\nreview and run: factory triage accept   (promotes ${proposedPath} -> ${queuePath})`;
}

export async function cmdTriageAccept(opts: { force?: boolean }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);

  if (!existsSync(paths.queueProposed)) {
    console.log(`nothing to accept — ${paths.queueProposed} not found`);
    return; // zero exit
  }

  const content = readFileSync(paths.queueProposed, 'utf-8');
  const result = validateQueue(content);

  if (!opts.force && !result.ok) {
    throw new CliExitError(
      `factory: proposed queue is invalid — ${paths.queueProposed} left unchanged\n` +
        result.errors.map((e) => `  - ${e}`).join('\n'),
      1,
    );
  }

  renameSync(paths.queueProposed, paths.queue); // same dir → atomic

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
    `accepted ${result.issues.length} issue(s) [${result.issues.join(', ')}] by ${acceptedBy}${suffix}`,
  );
  console.log(chalk.green(`queue accepted — ${result.issues.length} issue(s) promoted to ${paths.queue}`));
}

export function triageNoProposalError(plannerError: unknown): CliExitError {
  const detail = plannerError ? ` — planner failed: ${errorDetail(plannerError)}` : '';
  return new CliExitError(`triage produced no proposal${detail}`, 1);
}

async function cmdRun() {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  if (!existsSync(paths.queue)) {
    throw new CliExitError('queue empty — run factory init + triage first', 2);
  }

  const factoryConfig = loadFactoryConfig();
  if (factoryConfig.worktree.autoGcOnRun) {
    try {
      const gcLog = (type: string, msg: string) => logEvent(paths.events, type, '-', msg);
      const report = await withGitLock(repoRoot, () =>
        withFileLock(paths.gitLock, () =>
          sweepWorktrees({ repoRoot, ttlDays: factoryConfig.worktree.gcTtlDays }, { log: gcLog }),
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

  // Read queue
  const { entries, diagnostics } = parseQueue(readFileSync(paths.queue, 'utf-8'));
  warnQueueDiagnostics(diagnostics);

  // Group by lane
  const lanes = new Map<string, number[]>();
  for (const e of entries) {
    if (!lanes.has(e.lane)) lanes.set(e.lane, []);
    lanes.get(e.lane)!.push(e.issue);
  }

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

  // Run lanes in parallel
  const pids: Promise<void>[] = [];
  for (const [lane, issues] of lanes) {
    logEvent(paths.events, 'lane-start', '-', `lane '${lane}' started (${issues.length} issues)`, { lane });
    pids.push(runLane(lane, issues, repoRoot, ghRepo, paths));
  }

  await Promise.allSettled(pids);
  controller.abort();
  await watchdog;
  logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
}

/** Wraps cmdRun so an empty queue is a no-op (not a throw) while auto-ingest is enabled and watching. */
export function createSuperviseRunQueue(
  paths: ReturnType<typeof getFactoryPaths>,
  ingestCfg: IngestSettings,
  deps: { cmdRunFn?: () => Promise<void>; readQueueFile?: () => string; emitEvent?: typeof logEvent } = {},
): () => Promise<void> {
  const {
    cmdRunFn = cmdRun,
    readQueueFile = () => (existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : ''),
    emitEvent = logEvent,
  } = deps;
  return async () => {
    const queueContent = readQueueFile();
    if (parseQueue(queueContent).entries.length === 0 && ingestCfg.enabled) {
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
        queueFile: paths.queue,
        watermarkFile: paths.ingestWatermark,
        label: ingestCfg.label,
        lane: ingestCfg.lane,
        maxPerCycle: ingestCfg.maxPerCycle,
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

async function cmdSupervise(opts: { now?: boolean }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const ingestCfg = resolveIngestConfig(loadFactoryConfig());

  const content = existsSync(paths.queue) ? readFileSync(paths.queue, 'utf-8') : '';
  const { entries, diagnostics } = parseQueue(content);
  warnQueueDiagnostics(diagnostics);
  if (entries.length === 0 && !ingestCfg.enabled) {
    throw new CliExitError('queue empty — run factory init + triage first', 2);
  }

  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs(process.env, loadRepoConfig(repoRoot));
  } catch (err: any) {
    throw new CliExitError(`factory: ${err.message}`, 2);
  }

  await superviseLoop({
    cap: knobs.cap,
    resumeAt: knobs.resumeAt,
    pollMs: knobs.pollMs,
    watch: knobs.watch,
    estimator: knobs.estimator,
    stopFile: paths.stop,
    eventsFile: paths.events,
    now: opts.now,
    runQueue: createSuperviseRunQueue(paths, ingestCfg),
    ingest: ingestCfg.enabled ? createIngestHook(repoRoot, paths, ingestCfg) : undefined,
  });
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
};

export async function runLane(
  lane: string,
  issues: number[],
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  deps: RunLaneDeps = {},
) {
  const { ship = shipIssue, waitMerge = waitForMerge, pathExists = existsSync, emitEvent = logEvent } = deps;
  let merged = 0;
  let awaitingReview = 0;
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present', { lane });
      return;
    }
    try {
      const branch = await ship(issue, {}, { repoRoot, ghRepo, lane });
      await waitMerge(issue, branch, repoRoot, ghRepo, paths);
      merged++;
    } catch (err: any) {
      if (err instanceof AwaitingReviewError) {
        // The land path already emitted the awaiting-review event and cleaned the
        // worktree — this is a clean outcome, not a park; move to the next issue.
        awaitingReview++;
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
        `lane '${lane}' parked (${reason}); ${issues.length - i - 1} issues remaining`,
        { lane },
      );
      return;
    }
  }
  emitEvent(paths.events, 'lane-done', lane, `lane complete (${merged} merged, ${awaitingReview} awaiting review)`, {
    lane,
  });
}

export async function isPrMerged(octokit: Octokit, owner: string, repoName: string, branch: string): Promise<boolean> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo: repoName,
    state: 'closed',
    head: `${owner}:${branch}`,
  });
  return prs.some((pr: any) => Boolean(pr.merged_at));
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
): Promise<{ number: number; branch: string } | undefined> {
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
    if (pr) return { number: pr.number, branch: pr.head.ref };
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

export class AwaitingReviewError extends Error {
  constructor(
    message: string,
    readonly prNumber: number,
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
  log: (type: string, msg: string) => void;
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
  log: (type: string, msg: string) => void;
  run?: CommandRunner;
  pathExists?: (path: string) => boolean;
  sleep?: (ms: number) => Promise<void>;
  skipCI?: boolean;
  adminMerge?: boolean;
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
  } = opts;

  const watchCi = async () => {
    try {
      const outcome = await watchChecks({ octokit, owner, repo: repoName, ref: branch });
      if (outcome !== 'success') {
        log('warn', `CI watch for ${branch} ended ${outcome} — proceeding to merge state check`);
      }
    } catch (err) {
      log('warn', `CI watch for ${branch} failed: ${errorDetail(err)} — proceeding to merge state check`);
    }
  };

  if (!skipCI) {
    await watchCi();
  }
  let state = await getPullRequestLandState(octokit, owner, repoName, prNumber);

  if (state.mergeStateStatus === 'DIRTY') {
    await rebaseDirtyPullRequest({ issue, branch, worktree, prNumber, log, run, pathExists });
    if (!skipCI) {
      await watchCi();
    }
    state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
  }

  for (let attempt = 1; ; attempt++) {
    if (state.isDraft && state.id) {
      log('land', `PR #${prNumber} still a draft — re-issuing ready-for-review (attempt ${attempt})`);
      await markPullRequestReady(octokit, state.id).catch((err: unknown) =>
        log('warn', `ready-for-review flip failed for PR #${prNumber}: ${errorDetail(err)}`),
      );
    }
    try {
      await squashMergeAndDelete(octokit, owner, repoName, branch, prNumber, { admin: adminMerge, run });
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
      await sleep(MERGE_RETRY_BASE_MS * 2 ** (attempt - 1));
      state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
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
  loadConfig?: typeof loadFactoryConfig;
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
    loadConfig = loadFactoryConfig,
    listPRs = listOpenFactoryPRs,
    land = landIssue,
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
  } = deps;

  const [owner, repoName] = ghRepo.split('/');
  const octokit = createOctokit();
  const skipCI = resolveSkipCI(loadConfig());
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

type WaitForMergeDeps = {
  createOctokit?: () => Octokit;
  pathExists?: (path: string) => boolean;
  checkMerged?: typeof isPrMerged;
  loadConfig?: typeof loadFactoryConfig;
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
) {
  const {
    createOctokit = getOctokit,
    pathExists = existsSync,
    checkMerged = isPrMerged,
    loadConfig = loadFactoryConfig,
    land = landIssue,
    listIssueLabels = defaultListIssueLabels,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    mergeEnabled,
    writeLine = (line) => console.log(line),
  } = deps;
  const factoryConfig = loadConfig();
  const isMergeEnabled = mergeEnabled ?? (() => factoryConfig.merge.auto || process.env.FACTORY_MERGE === '1');
  const skipCI = resolveSkipCI(factoryConfig);
  const filingPolicy = resolveFilingPolicy(factoryConfig);
  const octokit = createOctokit();
  const [owner, repoName] = ghRepo.split('/');

  emitEvent(paths.events, 'await-merge', issue, `waiting to merge ${branch}`);
  while (!pathExists(paths.stop)) {
    let merged = false;
    try {
      merged = await checkMerged(octokit, owner, repoName, branch);
    } catch (err) {
      emitEvent(paths.events, 'warn', issue, `merged-state check failed (treating as not merged): ${errorDetail(err)}`);
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

  const triage = program
    .command('triage')
    .description('Propose a queue from open issues')
    .option('--product <name>', 'Product constitution to scope triage')
    .action(cmdTriage);

  triage
    .command('accept')
    .description('Validate and atomically promote .factory/queue.proposed to .factory/queue')
    .option('--force', 'Skip validation and promote as-is')
    .action(async (opts) => {
      await cmdTriageAccept(opts);
    });

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

  program.command('run').description('Process the whole queue (lanes in parallel)').action(cmdRun);

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
