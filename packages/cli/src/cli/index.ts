// packages/cli/src/cli/index.ts — CLI entry point: factory <command> [options]

import { Command } from 'commander';
import chalk from 'chalk';
import {
  loadModelsConfig,
  loadRoutesConfig,
  loadFactoryConfig,
  getFactoryPaths,
  getConstitutionsDir,
  ModelRouter,
  ConstitutionLoader,
  planPhase,
  buildPhase,
  checkPhase,
  shipPhase,
  estimateTrailingSpend,
  formatUsageReport,
  watchUsage,
  diagnoseModels,
} from '@on-par/factory-core';
import type { ModelDiagnosis } from '@on-par/factory-core';
import { logEvent, branchFor, readCosts, ensureDir, setupWorktree, cleanupWorktree, gitFetch, withGitLock, withFileLock, shellEscape } from '@on-par/factory-core';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { Octokit } from '@octokit/rest';
import { resolveConfigPath } from '@on-par/factory-config';

const exec = promisify(execCb);
type CommandRunner = (command: string, options?: { cwd?: string; timeout?: number }) => Promise<unknown>;

// ---------- helpers ----------

async function getRepoRoot(): Promise<string> {
  try {
    const { stdout } = await exec('git rev-parse --show-toplevel');
    return stdout.trim();
  } catch {
    console.error(chalk.red('factory: not inside a git repository'));
    process.exit(2);
  }
}

async function getGitHubRepo(): Promise<string> {
  try {
    const { stdout } = await exec('gh repo view --json nameWithOwner --jq .nameWithOwner');
    return stdout.trim();
  } catch {
    console.error(chalk.red('factory: no GitHub remote detected (gh repo view failed)'));
    process.exit(2);
  }
}

function getOctokit(): Octokit {
  return new Octokit({ auth: process.env.GITHUB_TOKEN ?? undefined });
}

// ---------- commands ----------

async function cmdInit() {
  const repoRoot = await getRepoRoot();
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
    writeFileSync(paths.queue, `# factory queue — "<lane> <issue#>", priority-ordered.
# Lanes run in parallel; issues within a lane run serially.
# Put issues that touch the same files in the same lane.
# Example:
#   app 61
#   docs 66
`);
  }

  console.log(chalk.green(`Initialized ${paths.state}`));
  console.log(`Next: factory constitution --product <name>, then factory triage`);
}

async function cmdConstitution(opts: { list?: boolean; product?: string }) {
  const loader = new ConstitutionLoader();

  if (opts.list) {
    const products = loader.listProducts();
    for (const p of products) console.log(`  ${p}`);
    return;
  }

  if (opts.product) {
    const constPath = resolve(getConstitutionsDir(), `${opts.product}.md`);
    if (!existsSync(constPath)) {
      console.error(chalk.red(`No constitution '${opts.product}' found`));
      process.exit(1);
    }
    const repoRoot = await getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    writeFileSync(paths.product, opts.product);
    console.log(chalk.green(`Active product: ${opts.product}`));
    return;
  }

  console.error('usage: factory constitution --list | --product <name>');
  process.exit(2);
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

async function cmdModels(opts: { doctor?: boolean } = {}) {
  const modelsConfig = loadModelsConfig();
  const { ModelRegistry } = await import('@on-par/factory-core');
  const registry = new ModelRegistry(modelsConfig);
  const allowExperimental = process.env.FACTORY_EXPERIMENTAL === '1';

  if (opts.doctor) {
    const diagnoses = diagnoseModels(registry, {}, allowExperimental);
    console.log(formatDoctorReport(diagnoses));
    if (!hasReachableWorker(diagnoses)) {
      console.error(chalk.red('factory: no worker model is reachable — fix the reasons above before running a queue'));
      process.exit(1);
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

async function cmdCost() {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);
  const costs = readCosts(paths.costs);
  if (costs.length === 0) {
    console.log('no cost data yet');
    return;
  }

  const byModel = new Map<string, { tasks: number; total: number }>();
  for (const c of costs) {
    const e = byModel.get(c.model) ?? { tasks: 0, total: 0 };
    e.tasks++;
    e.total += c.cost;
    byModel.set(c.model, e);
  }

  console.log(chalk.bold('== Cost Summary =='));
  for (const [model, { tasks, total }] of byModel) {
    console.log(`  ${model}: ${tasks} tasks, $${total.toFixed(4)}`);
  }
  const grandTotal = costs.reduce((s, c) => s + c.cost, 0);
  console.log('  ---');
  console.log(`  Total: $${grandTotal.toFixed(4)}`);
}

export interface UsageKnobs {
  cap: number;
  stopAt: number;
  resumeAt: number;
  pollMs: number;
  watch: boolean;
}

export function resolveUsageKnobs(env: NodeJS.ProcessEnv = process.env): UsageKnobs {
  const cap = Number(env.FACTORY_USAGE_CAP ?? 227);
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error('FACTORY_USAGE_CAP must be a positive number');
  }

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
  };
}

async function cmdUsage() {
  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs();
  } catch (err: any) {
    console.error(chalk.red(`factory: ${err.message}`));
    process.exit(2);
  }

  const spend = estimateTrailingSpend();
  console.log(formatUsageReport(spend, knobs.cap));
}

async function cmdStatus() {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  const modelsConfig = loadModelsConfig();
  const routesConfig = loadRoutesConfig();
  const router = new ModelRouter(modelsConfig, routesConfig);
  const product = existsSync(paths.product) ? readFileSync(paths.product, 'utf-8').trim() : '(none)';

  console.log(chalk.bold(`== ${ghRepo} ==`));
  console.log(`Product: ${product}`);
  console.log(`Plan model: ${router.resolve('plan') ?? 'none'}`);
  console.log(`Build model: ${router.resolve('build_claude') ?? 'none'}`);
  console.log(`Checker model: ${router.resolve('check_tests') ?? 'none'}`);

  console.log(chalk.bold('\n== Queue =='));
  if (existsSync(paths.queue)) {
    const queue = readFileSync(paths.queue, 'utf-8');
    const lines = queue.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    if (lines.length > 0) {
      for (const l of lines) console.log(`  ${l}`);
    } else {
      console.log('  (empty)');
    }
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

  if (existsSync(paths.stop)) {
    console.log(chalk.red('\n!! STOP file present — factory halting between issues'));
  }
}

export type ParkReason = 'escalate' | 'timeout' | 'fail' | 'conflict';

export class LaneParkError extends Error {
  constructor(message: string, readonly reason: ParkReason) {
    super(message);
  }
}

export function parkReasonFor(err: unknown): ParkReason {
  if (err instanceof LaneParkError) return err.reason;
  if (err instanceof LandConflictError) return 'conflict';
  if ((err as any)?.reason === 'timeout') return 'timeout';
  return 'fail';
}

export async function shipIssue(issueNum: number, opts: { product?: string; autoRework?: boolean }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();

  const modelsConfig = loadModelsConfig();
  const routesConfig = loadRoutesConfig();
  const router = new ModelRouter(modelsConfig, routesConfig);
  const constitutionLoader = new ConstitutionLoader();

  const product = opts.product ?? (existsSync(paths.product) ? readFileSync(paths.product, 'utf-8').trim() : undefined);
  const autoRework = opts.autoRework ?? true;

  const branch = branchFor(issueNum, await getIssueTitle(octokit, ghRepo, issueNum));
  const worktree = worktreePathFor(repoRoot, issueNum);
  const specPath = resolve(paths.plans, `issue-${issueNum}.md`);

  const log = (type: string, msg: string) => logEvent(paths.events, type, issueNum, msg);

  // PLAN
  const plan = await planPhase({ issue: issueNum, repo: ghRepo, worktree, specPath, product, router, constitutionLoader, octokit, log });
  if (!plan.ok) {
    throw new LaneParkError(`plan escalated: ${plan.escalate ?? 'unknown'}`, 'escalate');
  }

  // Setup worktree
  await withGitLock(repoRoot, () =>
    withFileLock(paths.gitLock, async () => {
      await gitFetch(repoRoot);
      await setupWorktree(repoRoot, branch, worktree);
    }, { onSteal: pid => log('lock-stolen', `stole ${paths.gitLock} from dead holder pid ${pid ?? 'unknown'}`) })
  );
  log('worktree', `Worktree ready at ${worktree}`);

  // BUILD
  const build = await buildPhase({ issue: issueNum, repo: ghRepo, worktree, specPath, branch, product, route: plan.route, router, constitutionLoader, log });
  if (!build.ok) {
    throw new LaneParkError(`build escalated: ${build.escalate ?? 'unknown'}`, 'escalate');
  }

  // CHECK
  const check = await checkPhase({ issue: issueNum, worktree, specPath, product, router, constitutionLoader, log, autoRework });
  if (!check.passed) {
    const failures = check.summary.results.filter(r => r.result === 'FAIL');
    for (const f of failures) {
      console.error(chalk.red(`  FAIL: ${f.checker} — ${f.details}`));
    }
    throw new LaneParkError(`${check.summary.failures} check failures after ${check.reworkRounds} rework rounds`, 'fail');
  }

  // SHIP
  const ship = await shipPhase({ issue: issueNum, repo: ghRepo, worktree, branch, octokit, log });
  if (!ship.ok) {
    throw new LaneParkError('ship phase failed', 'fail');
  }

  log('ready', `PR #${ship.prNumber} ready for review`);
  console.log(chalk.green(`✅ Issue #${issueNum} → PR #${ship.prNumber} ready for review`));
  return branch;
}

async function cmdShip(issueNum: number, opts: { product?: string; autoRework?: boolean }) {
  try {
    return await shipIssue(issueNum, opts);
  } catch (err: any) {
    const repoRoot = await getRepoRoot();
    const paths = getFactoryPaths(repoRoot);
    logEvent(paths.events, parkReasonFor(err), issueNum, err.message);
    console.error(chalk.red(`Ship failed for issue #${issueNum}: ${err.message}`));
    process.exit(1);
  }
}

async function getIssueTitle(octokit: Octokit, repo: string, issue: number): Promise<string> {
  const [owner, repoName] = repo.split('/');
  const { data } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
  return data.title;
}

function worktreePathFor(repoRoot: string, issueNum: number): string {
  return resolve(dirname(repoRoot), `${basename(repoRoot)}-factory-${issueNum}`);
}

async function cmdLand(issueNum: number) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const octokit = getOctokit();

  try {
    const result = await landIssue(issueNum, repoRoot, ghRepo, paths, octokit);
    console.log(chalk.green(`✅ Landed PR #${result.prNumber} for issue #${issueNum}`));
  } catch (err: any) {
    if (err instanceof LandConflictError) {
      console.error(chalk.red(`factory: ${err.message}`));
      process.exit(3);
    }
    if (err instanceof LandFailureError) {
      console.error(chalk.red(`factory: ${err.message}`));
      process.exit(err.code);
    }
    console.error(chalk.red(`factory: merge failed for issue #${issueNum}: ${err.message}`));
    process.exit(5);
  }
}

async function landIssue(
  issueNum: number,
  repoRoot: string,
  ghRepo: string,
  paths: ReturnType<typeof getFactoryPaths>,
  octokit: Octokit,
): Promise<{ branch: string; prNumber: number }> {
  const [owner, repoName] = ghRepo.split('/');
  const log = (type: string, msg: string) => logEvent(paths.events, type, issueNum, msg);

  // The issue title may have been edited since the PR was opened, so a
  // freshly-derived branch name can drift from the branch the PR actually
  // lives on (same failure mode fixed for waitForMerge in #51). Guess the
  // branch from the current title first, but fall back to matching the open
  // PR that references this issue directly and use its real head branch.
  const guessedBranch = branchFor(issueNum, await getIssueTitle(octokit, ghRepo, issueNum));
  const worktree = worktreePathFor(repoRoot, issueNum);

  const [, guessedPrNumber] = await Promise.all([
    gitFetch(repoRoot),
    findOpenPRNumber(octokit, owner, repoName, guessedBranch),
  ]);

  let branch = guessedBranch;
  let prNumber = guessedPrNumber;
  if (!prNumber) {
    const fallback = await findOpenPRForIssue(octokit, owner, repoName, issueNum);
    if (fallback) {
      branch = fallback.branch;
      prNumber = fallback.number;
    }
  }

  if (!prNumber) {
    log('fail', `no open PR for ${guessedBranch}`);
    throw new LandFailureError(`no open PR for issue #${issueNum} (${guessedBranch})`, 1);
  }

  try {
    await withGitLock(repoRoot, () =>
      withFileLock(paths.mergeLock, async () => {
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
        });
        log('merged', `squash-merged PR #${prNumber}`);
        await cleanupWorktree(repoRoot, worktree, log);
      }, { onSteal: pid => log('lock-stolen', `stole ${paths.mergeLock} from dead holder pid ${pid ?? 'unknown'}`) })
    );
  } catch (err: any) {
    if (err instanceof LandConflictError) throw err;
    log('fail', `merge failed: ${err.message}`);
    throw new LandFailureError(`merge failed for issue #${issueNum}: ${err.message}`, 5);
  }

  return { branch, prNumber };
}

async function cmdTriage(opts: { product?: string }) {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);
  const product = opts.product ?? (existsSync(paths.product) ? readFileSync(paths.product, 'utf-8').trim() : undefined);

  const modelsConfig = loadModelsConfig();
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
explaining exclusions.` ;

  logEvent(paths.events, 'triage', '-', `Triaging ${ghRepo} with ${model}`);
  const { stdout } = await exec(
    `claude -p ${shellEscapeInline(prompt)} ${flag ? `--model ${flag}` : ''} --allowedTools "Bash(gh issue:*)" "Bash(gh repo:*)" Read Glob Grep Write`,
  ).catch(() => ({ stdout: '' }));

  const proposed = existsSync(paths.queueProposed) ? readFileSync(paths.queueProposed, 'utf-8') : '';
  const message = triageProposalMessage(proposed, paths.queueProposed, paths.queue);
  if (message) {
    console.log(message);
  } else {
    console.error('triage produced no proposal');
    process.exit(1);
  }
}

export function triageProposalMessage(proposed: string, proposedPath: string, queuePath: string): string | null {
  if (!proposed.trim()) return null;
  return `${proposed}\n---\nreview and: mv ${proposedPath} ${queuePath}`;
}

function shellEscapeInline(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function cmdRun() {
  const repoRoot = await getRepoRoot();
  const ghRepo = await getGitHubRepo();
  const paths = getFactoryPaths(repoRoot);

  if (!existsSync(paths.queue)) {
    console.error('queue empty — run factory init + triage first');
    process.exit(2);
  }

  // Read queue
  const queueLines = readFileSync(paths.queue, 'utf-8')
    .split('\n')
    .filter(l => l.trim() && !l.trim().startsWith('#'));

  // Group by lane
  const lanes = new Map<string, number[]>();
  for (const line of queueLines) {
    const [lane, issue] = line.trim().split(/\s+/);
    if (!lane || !issue) continue;
    if (!lanes.has(lane)) lanes.set(lane, []);
    lanes.get(lane)!.push(parseInt(issue, 10));
  }

  const knobs = resolveUsageKnobs();
  const controller = new AbortController();
  const watchdog = knobs.watch
    ? watchUsage({
        cap: knobs.cap,
        stopAt: knobs.stopAt,
        pollMs: knobs.pollMs,
        stopFile: paths.stop,
        eventsFile: paths.events,
        signal: controller.signal,
      }).catch((err: any) => {
        // a watchdog crash must never take down the run
        console.error(chalk.red(`factory: usage watchdog crashed: ${err.message}`));
      })
    : Promise.resolve();

  // Run lanes in parallel
  const pids: Promise<void>[] = [];
  for (const [lane, issues] of lanes) {
    console.log(chalk.cyan(`[factory] lane '${lane}' started (${issues.length} issues)`));
    pids.push(runLane(lane, issues, repoRoot, ghRepo, paths));
  }

  await Promise.allSettled(pids);
  controller.abort();
  await watchdog;
  logEvent(paths.events, 'run-done', 'all', 'all lanes finished');
}

async function cmdSupervise(opts: { now?: boolean }) {
  const repoRoot = await getRepoRoot();
  const paths = getFactoryPaths(repoRoot);

  const queueLines = existsSync(paths.queue)
    ? readFileSync(paths.queue, 'utf-8').split('\n').filter(l => l.trim() && !l.trim().startsWith('#'))
    : [];
  if (queueLines.length === 0) {
    console.error('queue empty — run factory init + triage first');
    process.exit(2);
  }

  let knobs: UsageKnobs;
  try {
    knobs = resolveUsageKnobs();
  } catch (err: any) {
    console.error(chalk.red(`factory: ${err.message}`));
    process.exit(2);
  }

  await superviseLoop({
    cap: knobs.cap,
    resumeAt: knobs.resumeAt,
    pollMs: knobs.pollMs,
    stopFile: paths.stop,
    eventsFile: paths.events,
    now: opts.now,
    runQueue: () => cmdRun(),
  });
}

type RunLaneDeps = {
  ship?: (issue: number, opts: {}) => Promise<string>;
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
  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    if (pathExists(paths.stop)) {
      emitEvent(paths.events, 'stopped', issue, 'STOP file present');
      return;
    }
    try {
      const branch = await ship(issue, {});
      await waitMerge(issue, branch, repoRoot, ghRepo, paths);
    } catch (err: any) {
      const reason = parkReasonFor(err);
      console.error(chalk.red(`[factory] lane '${lane}' #${issue} parked (${reason}): ${err.message}`));
      emitEvent(paths.events, reason, issue, err.message);
      emitEvent(paths.events, 'parked', issue, `lane '${lane}' parked (${reason}); ${issues.length - i - 1} issues remaining`);
      return;
    }
  }
  emitEvent(paths.events, 'lane-done', lane, 'lane complete');
}

export async function isPrMerged(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
): Promise<boolean> {
  const { data: prs } = await octokit.rest.pulls
    .list({ owner, repo: repoName, state: 'closed', head: `${owner}:${branch}` })
    .catch(() => ({ data: [] as any[] }));
  return prs.some((pr: any) => Boolean(pr.merged_at));
}

export async function findOpenPRNumber(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
): Promise<number | undefined> {
  const { data: prs } = await octokit.rest.pulls
    .list({ owner, repo: repoName, state: 'open', head: `${owner}:${branch}` })
    .catch(() => ({ data: [] as any[] }));
  return prs[0]?.number;
}

export async function findOpenPRForIssue(
  octokit: Octokit,
  owner: string,
  repoName: string,
  issueNum: number,
): Promise<{ number: number; branch: string } | undefined> {
  const { data: prs } = await octokit.rest.pulls
    .list({ owner, repo: repoName, state: 'open', per_page: 100 })
    .catch(() => ({ data: [] as any[] }));
  const pr = prs.find((p: any) => new RegExp(`\\bcloses\\s+#${issueNum}\\b`, 'i').test(p.body ?? ''));
  return pr ? { number: pr.number, branch: pr.head.ref } : undefined;
}

export async function squashMergeAndDelete(
  octokit: Octokit,
  owner: string,
  repoName: string,
  branch: string,
  prNumber: number,
): Promise<void> {
  await octokit.rest.pulls.merge({ owner, repo: repoName, pull_number: prNumber, merge_method: 'squash' });
  // Best-effort branch delete: the merge is the source of truth.
  await octokit.rest.git
    .deleteRef({ owner, repo: repoName, ref: `heads/${branch}` })
    .catch(() => {});
}

export class LandConflictError extends Error {}

export class LandFailureError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

const MAX_MERGE_ATTEMPTS = 5;
const MERGE_RETRY_BASE_MS = 5_000;

export async function getPullRequestLandState(
  octokit: Octokit,
  owner: string,
  repoName: string,
  prNumber: number,
): Promise<{ id?: string; isDraft?: boolean; mergeStateStatus?: string }> {
  const result = await octokit.graphql<{
    repository?: { pullRequest?: { id?: string; isDraft?: boolean; mergeStateStatus?: string } };
  }>(
    `query PullRequestLandState($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          id
          isDraft
          mergeStateStatus
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

export async function watchPullRequestChecks(
  prNumber: number,
  ghRepo: string,
  repoRoot: string,
  run: CommandRunner = exec,
): Promise<void> {
  await run(
    `gh pr checks ${shellEscape(String(prNumber))} --repo ${shellEscape(ghRepo)} --watch --fail-fast`,
    { cwd: repoRoot, timeout: 600_000 },
  ).catch(() => {});
}

export async function rebaseDirtyPullRequest(
  opts: {
    issue: number;
    branch: string;
    worktree: string;
    prNumber: number;
    log: (type: string, msg: string) => void;
    run?: CommandRunner;
    pathExists?: (path: string) => boolean;
  },
): Promise<void> {
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
    await run('git rebase --abort', { cwd: worktree }).catch(() => {});
    const msg = `rebase conflict on ${branch} — parked`;
    log('conflict', msg);
    throw new LandConflictError(`issue #${issue}: ${msg}`);
  }
}

export async function landOpenPullRequest(
  opts: {
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
  },
): Promise<void> {
  const {
    octokit,
    owner,
    repoName,
    ghRepo,
    repoRoot,
    issue,
    branch,
    worktree,
    prNumber,
    log,
    run,
    pathExists,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  } = opts;

  await watchPullRequestChecks(prNumber, ghRepo, repoRoot, run);
  let state = await getPullRequestLandState(octokit, owner, repoName, prNumber);

  if (state.mergeStateStatus === 'DIRTY') {
    await rebaseDirtyPullRequest({ issue, branch, worktree, prNumber, log, run, pathExists });
    await watchPullRequestChecks(prNumber, ghRepo, repoRoot, run);
    state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
  }

  for (let attempt = 1; ; attempt++) {
    if (state.isDraft && state.id) {
      log('land', `PR #${prNumber} still a draft — re-issuing ready-for-review (attempt ${attempt})`);
      await markPullRequestReady(octokit, state.id).catch(() => {});
    }
    try {
      await squashMergeAndDelete(octokit, owner, repoName, branch, prNumber);
      return;
    } catch (err: any) {
      if (attempt >= MAX_MERGE_ATTEMPTS) throw err;
      log('land', `merge attempt ${attempt}/${MAX_MERGE_ATTEMPTS} failed (${err.message}); mergeStateStatus=${state.mergeStateStatus ?? 'unknown'} — retrying with backoff`);
      await sleep(MERGE_RETRY_BASE_MS * 2 ** (attempt - 1));
      state = await getPullRequestLandState(octokit, owner, repoName, prNumber);
    }
  }
}

type WaitForMergeDeps = {
  createOctokit?: () => Octokit;
  pathExists?: (path: string) => boolean;
  checkMerged?: typeof isPrMerged;
  land?: (
    issueNum: number,
    repoRoot: string,
    ghRepo: string,
    paths: ReturnType<typeof getFactoryPaths>,
    octokit: Octokit,
  ) => Promise<{ branch: string; prNumber: number }>;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  mergeEnabled?: () => boolean;
  writeLine?: (line: string) => void;
};

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
    land = landIssue,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    mergeEnabled = () => process.env.FACTORY_MERGE === '1',
    writeLine = line => console.log(line),
  } = deps;
  const octokit = createOctokit();
  const [owner, repoName] = ghRepo.split('/');

  while (!pathExists(paths.stop)) {
    if (await checkMerged(octokit, owner, repoName, branch)) {
      emitEvent(paths.events, 'landed', issue, 'PR merged');
      return;
    }

    if (mergeEnabled()) {
      await land(issue, repoRoot, ghRepo, paths, octokit);
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
  stopFile: string;
  eventsFile: string;
  now?: boolean;
  runQueue: () => Promise<void>;
  estimateSpend?: () => number;
  pathExists?: (path: string) => boolean;
  clearStop?: (path: string) => void;
  sleep?: (ms: number) => Promise<void>;
  emitEvent?: typeof logEvent;
  writeLine?: (line: string) => void;
}

export async function superviseLoop(deps: SuperviseDeps): Promise<void> {
  const {
    cap,
    resumeAt,
    pollMs,
    stopFile,
    eventsFile,
    now,
    runQueue,
    estimateSpend = estimateTrailingSpend,
    pathExists = existsSync,
    clearStop = (path: string) => rmSync(path, { force: true }),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    emitEvent = logEvent,
    writeLine = (line: string) => console.log(line),
  } = deps;

  let cycle = 0;
  while (true) {
    cycle++;
    let pct = estimateSpend() / cap;
    if (cycle > 1 || !now) {
      while (pct >= resumeAt) {
        writeLine(`[factory] supervise: trailing usage ${Math.round(pct * 100)}% >= resume gate ${Math.round(resumeAt * 100)}% — waiting ${pollMs / 1000}s`);
        await sleep(pollMs);
        pct = estimateSpend() / cap;
      }
    }
    emitEvent(eventsFile, 'resumed', 'usage', `supervise cycle ${cycle}: trailing usage at ${Math.round(pct * 100)}% of cap — starting run`);
    clearStop(stopFile);
    await runQueue();
    if (!pathExists(stopFile)) break;
  }
  emitEvent(eventsFile, 'supervisor-done', 'usage', 'supervise finished — queue drained or lanes need attention');
}

// ---------- main ----------

export async function main() {
  const program = new Command();

  program
    .name('factory')
    .description('Multi-agent software factory with boss-worker-checker orchestration')
    .version('2.0.0');

  program.command('init').description('Initialize .factory in this repo').action(cmdInit);

  program
    .command('constitution')
    .description('Manage product constitutions')
    .option('--list', 'List available constitutions')
    .option('--product <name>', 'Set active product constitution')
    .action(cmdConstitution);

  program
    .command('models')
    .description('List available models and costs')
    .option('--doctor', 'Probe provider CLIs and env keys; report per-model reachability')
    .action(cmdModels);

  program.command('cost').description('Show cost tracking summary').action(cmdCost);

  program.command('usage').description('Report trailing-5h cost-weighted subscription usage vs cap').action(cmdUsage);

  program.command('status').description('Show queue, events, PRs, models').action(cmdStatus);

  program
    .command('triage')
    .description('Propose a queue from open issues')
    .option('--product <name>', 'Product constitution to scope triage')
    .action(cmdTriage);

  program
    .command('ship <issue>')
    .description('Plan → build → check → ship one issue')
    .option('--product <name>', 'Override active product constitution')
    .option('--no-auto-rework', 'Disable automatic rework loop')
    .action(async (issueNum, opts) => {
      await cmdShip(issueNum, opts);
    });

  program
    .command('land <issue>')
    .description('Squash-merge a ready PR and clean up its worktree')
    .action(async (issueNum) => {
      await cmdLand(parseInt(issueNum, 10));
    });

  program.command('run').description('Process the whole queue (lanes in parallel)').action(cmdRun);

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
        await import('node:fs/promises').then(fs => fs.unlink(paths.stop));
      }
      console.log('STOP cleared');
    });

  await program.parseAsync(process.argv);
}

// Run if invoked directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(chalk.red(err.message));
    process.exit(1);
  });
}
