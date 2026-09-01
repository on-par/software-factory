// src/utils/index.ts — Shared utilities: logging, git ops, cost tracking, shell helpers

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import { createLogger } from '../logger/index.js';
import type { CostEntry, FailoverReason, LogLevel, ReadinessInfo, ReworkInfo } from '../types/index.js';
import { levelForType } from './format.js';
import { execGit } from './git-exec.js';
import { createMicroVm, removeMicroVm, type WorktreeSandbox } from './microvm.js';

export type { WorktreeSandbox } from './microvm.js';

export { colorEnabled, formatEventLine, levelForType } from './format.js';

// ---------- Event Logging ----------

export function logEvent(
  eventsFile: string,
  type: EventKind,
  issue: string | number,
  msg: string,
  extra?: {
    failoverReason?: FailoverReason;
    lane?: string;
    phase?: string;
    level?: LogLevel;
    rework?: ReworkInfo;
    readiness?: ReadinessInfo;
    actor?: string;
    model?: string;
    tokens?: { input: number; output: number };
  },
): void {
  const logger = createLogger(eventsFile, { issue, lane: extra?.lane, phase: extra?.phase });
  const level = extra?.level ?? levelForType(type);
  const meta: {
    failoverReason?: FailoverReason;
    rework?: ReworkInfo;
    readiness?: ReadinessInfo;
    actor?: string;
    model?: string;
    tokens?: { input: number; output: number };
  } = {};
  if (extra?.failoverReason) meta.failoverReason = extra.failoverReason;
  if (extra?.rework) meta.rework = extra.rework;
  if (extra?.readiness) meta.readiness = extra.readiness;
  if (extra?.actor) meta.actor = extra.actor;
  if (extra?.model) meta.model = extra.model;
  if (extra?.tokens) meta.tokens = extra.tokens;
  logger[level](type, msg, Object.keys(meta).length > 0 ? meta : undefined);
}

// ---------- Cost Tracking ----------

export function logCost(costsFile: string, entry: Omit<CostEntry, 'ts'>): void {
  const full: CostEntry = { ...entry, ts: new Date().toISOString() };
  const line = JSON.stringify(full) + '\n';
  try {
    appendFileSync(costsFile, line);
  } catch {
    mkdirSync(resolve(costsFile, '..'), { recursive: true });
    appendFileSync(costsFile, line);
  }
}

export function readCosts(costsFile: string): CostEntry[] {
  if (!existsSync(costsFile)) return [];
  return readFileSync(costsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as CostEntry];
      } catch {
        return [];
      }
    });
}

// ---------- Git Operations ----------

// Every git call below runs through execGit, which imposes a hard deadline and
// kills the child on expiry. Without one, a wedged worktree op hangs its caller
// forever with no output — the failure mode #755 was opened for.
export async function gitFetch(repoRoot: string): Promise<void> {
  await execGit('git fetch origin -q', { cwd: repoRoot });
}

export async function setupWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
  startPoint: string = 'origin/main',
  sandbox?: WorktreeSandbox,
  log?: (type: EventKind, msg: string) => void,
): Promise<void> {
  await execGit(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot }).catch(() => {});
  await execGit(`git branch -D ${shellEscape(branch)}`, { cwd: repoRoot }).catch(() => {});
  await execGit(`git worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} ${shellEscape(startPoint)}`, {
    cwd: repoRoot,
  });
  if (sandbox) {
    await createMicroVm({ ...sandbox, worktreePath, log });
  }
}

export async function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
  log: (type: EventKind, msg: string) => void = () => {},
  sandbox?: WorktreeSandbox,
): Promise<void> {
  if (sandbox) {
    await removeMicroVm({ ...sandbox, worktreePath, log });
  }
  await execGit(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot }).catch((err: any) =>
    log(
      'warn',
      `git worktree remove failed for ${worktreePath}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    ),
  );
  await execGit('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log(
      'warn',
      `git worktree prune failed in ${repoRoot}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    ),
  );
}

export function slugify(s: string): string {
  // The [^a-z0-9]+ pass always collapses runs of non-alphanumeric characters to a
  // single '-', so at most one '-' can ever remain at either boundary below — a `+`
  // quantifier there would be redundant and is a polynomial-backtracking regex on
  // attacker-controlled input (CodeQL js/polynomial-redos).
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32)
    .replace(/-$/, '');
}

export function branchPrefixSlug(prefix?: string): string {
  return slugify(prefix || 'ship-it') || 'ship-it';
}

export function branchFor(issue: number, title: string, prefix?: string): string {
  return `${branchPrefixSlug(prefix)}/${issue}-${slugify(title)}`;
}

export async function getIssueTitle(repo: string, issue: number, octokit: any): Promise<string> {
  const { data } = await octokit.rest.issues.get({
    owner: repo.split('/')[0],
    repo: repo.split('/')[1],
    issue_number: issue,
  });
  return data.title;
}

// ---------- Shell helpers ----------

export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------- File helpers ----------

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function readJsonIfExists<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// ---------- Escalation ----------

/**
 * Shared escalation predicate. An output escalates iff some line begins with `ESCALATE:`.
 * Line-start semantics (stricter): a mid-paragraph mention of ESCALATE: in prose does NOT count.
 * Used by both production phases and the eval scorer so evals match production behavior.
 */
export function isEscalation(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('ESCALATE:'));
}

/** The first `ESCALATE:`-prefixed line, or undefined when the output is not an escalation. */
export function escalationLine(output: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith('ESCALATE:'));
}
