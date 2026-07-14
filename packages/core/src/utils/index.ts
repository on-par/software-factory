// src/utils/index.ts — Shared utilities: logging, git ops, cost tracking, shell helpers

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import type { FactoryEvent, CostEntry } from '../types/index.js';

const exec = promisify(execCb);

// ---------- Event Logging ----------

export function logEvent(eventsFile: string, type: string, issue: string | number, msg: string): void {
  const event: FactoryEvent = {
    ts: new Date().toISOString(),
    type,
    issue: String(issue),
    msg,
  };
  const line = JSON.stringify(event) + '\n';
  try {
    appendFileSync(eventsFile, line);
  } catch {
    mkdirSync(resolve(eventsFile, '..'), { recursive: true });
    appendFileSync(eventsFile, line);
  }
  console.log(`[factory] ${type} #${issue}: ${msg}`);
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
    .flatMap(l => {
      try {
        return [JSON.parse(l) as CostEntry];
      } catch {
        return [];
      }
    });
}

// ---------- Git Operations ----------

export async function gitFetch(repoRoot: string): Promise<void> {
  await exec('git fetch origin -q', { cwd: repoRoot });
}

export async function setupWorktree(
  repoRoot: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  await exec(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot }).catch(() => {});
  await exec(`git branch -D ${shellEscape(branch)}`, { cwd: repoRoot }).catch(() => {});
  await exec(`git worktree add -b ${shellEscape(branch)} ${shellEscape(worktreePath)} origin/main`, { cwd: repoRoot });
}

export async function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
  log: (type: string, msg: string) => void = () => {},
): Promise<void> {
  await exec(`git worktree remove --force ${shellEscape(worktreePath)}`, { cwd: repoRoot })
    .catch((err: any) =>
      log('warn', `git worktree remove failed for ${worktreePath}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`),
    );
  await exec('git worktree prune', { cwd: repoRoot })
    .catch((err: any) =>
      log('warn', `git worktree prune failed in ${repoRoot}: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`),
    );
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');
}

export function branchPrefixSlug(): string {
  return slugify(process.env.FACTORY_BRANCH_PREFIX || 'ship-it') || 'ship-it';
}

export function branchFor(issue: number, title: string): string {
  return `${branchPrefixSlug()}/${issue}-${slugify(title)}`;
}

export async function getIssueTitle(repo: string, issue: number, octokit: any): Promise<string> {
  const { data } = await octokit.rest.issues.get({ owner: repo.split('/')[0], repo: repo.split('/')[1], issue_number: issue });
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
  return output.split('\n').some(line => line.startsWith('ESCALATE:'));
}

/** The first `ESCALATE:`-prefixed line, or undefined when the output is not an escalation. */
export function escalationLine(output: string): string | undefined {
  return output.split('\n').find(line => line.startsWith('ESCALATE:'));
}

/** FACTORY_CODEX=0 kill-switch: force all work onto the Claude route. */
export function codexDisabled(): boolean {
  return process.env.FACTORY_CODEX === '0';
}
