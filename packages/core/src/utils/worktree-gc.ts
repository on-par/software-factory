// src/utils/worktree-gc.ts — Stale factory worktree cleanup + credential scrub

import { exec as execCb } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { shellEscape } from './index.js';

const exec = promisify(execCb);

export type GcReason = 'merged' | 'remote-gone' | 'ttl-expired';

export interface WorktreeListEntry {
  path: string;
  head: string | null;
  branch: string | null;
}

export interface GcCandidate {
  path: string;
  branch: string | null;
  ageDays: number;
  reason: GcReason;
  scrubbedFiles: string[];
}

export interface GcReport {
  removed: GcCandidate[];
  kept: number;
  dryRun: boolean;
}

export interface SweepDeps {
  runCommand?: (cmd: string, opts?: { cwd?: string }) => Promise<{ stdout: string }>;
  now?: () => number;
  log?: (type: string, msg: string) => void;
}

const CREDENTIAL_BASENAMES = new Set(['.git-credentials', '.npmrc']);

export function parseWorktreeList(porcelain: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  const blocks = porcelain
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  for (const block of blocks) {
    let path: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;

    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) {
        path = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        branch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      }
    }

    if (path) {
      entries.push({ path, head, branch });
    }
  }

  return entries;
}

export function findCredentialFiles(worktreePath: string): string[] {
  const found: string[] = [];

  let topLevel: string[];
  try {
    topLevel = readdirSync(worktreePath);
  } catch {
    return found;
  }

  for (const name of topLevel) {
    if (name === '.env' || name.startsWith('.env.') || CREDENTIAL_BASENAMES.has(name)) {
      const filePath = join(worktreePath, name);
      try {
        if (statSync(filePath).isFile()) found.push(filePath);
      } catch {}
    }
  }

  const claudeDir = join(worktreePath, '.claude');
  if (existsSync(claudeDir)) {
    walkFiles(claudeDir, found);
  }

  return found;
}

function walkFiles(dir: string, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, found);
    } else if (entry.isFile()) {
      found.push(full);
    }
  }
}

export function zeroFill(filePath: string): void {
  const size = statSync(filePath).size;
  writeFileSync(filePath, Buffer.alloc(size));
}

export function scrubFile(filePath: string): void {
  zeroFill(filePath);
  rmSync(filePath, { force: true });
}

async function defaultRunCommand(cmd: string, opts?: { cwd?: string }): Promise<{ stdout: string }> {
  const { stdout } = await exec(cmd, opts);
  return { stdout: stdout.toString() };
}

function safeExec(
  runCommand: NonNullable<SweepDeps['runCommand']>,
  cmd: string,
  opts?: { cwd?: string },
): Promise<{ stdout: string } | null> {
  return runCommand(cmd, opts).catch(() => null);
}

export async function sweepWorktrees(
  opts: { repoRoot: string; ttlDays: number; dryRun?: boolean },
  deps: SweepDeps = {},
): Promise<GcReport> {
  const { runCommand = defaultRunCommand, now = () => Date.now(), log = () => {} } = deps;
  const { repoRoot, ttlDays, dryRun = false } = opts;

  const { stdout } = await runCommand('git worktree list --porcelain', { cwd: repoRoot });
  const entries = parseWorktreeList(stdout);

  const repoRootResolved = resolve(repoRoot);
  const repoBase = basename(repoRootResolved);
  const factoryPrefix = `${repoBase}-factory-`;

  const candidates: WorktreeListEntry[] = entries.filter((entry) => {
    const entryPath = resolve(entry.path);
    if (entryPath === repoRootResolved) return false;
    return basename(entryPath).startsWith(factoryPrefix);
  });

  const removed: GcCandidate[] = [];
  let kept = 0;

  for (const entry of candidates) {
    const ageDays = computeAgeDays(entry.path, now);

    let reason: GcReason | null = null;
    if (ageDays > ttlDays) {
      reason = 'ttl-expired';
    } else if (entry.head) {
      const ancestorResult = await safeExec(
        runCommand,
        `git merge-base --is-ancestor ${shellEscape(entry.head)} origin/main`,
        { cwd: repoRoot },
      );
      if (ancestorResult !== null) {
        reason = 'merged';
      }
    }

    if (!reason && entry.branch) {
      const lsRemote = await safeExec(runCommand, `git ls-remote --heads origin ${shellEscape(entry.branch)}`, {
        cwd: repoRoot,
      });
      if (lsRemote !== null && lsRemote.stdout.trim() === '') {
        reason = 'remote-gone';
      }
    }

    if (!reason) {
      kept++;
      continue;
    }

    removed.push({
      path: entry.path,
      branch: entry.branch,
      ageDays,
      reason,
      scrubbedFiles: [],
    });
  }

  if (dryRun) {
    return { removed, kept, dryRun: true };
  }

  for (const candidate of removed) {
    const credentialFiles = findCredentialFiles(candidate.path);
    for (const filePath of credentialFiles) {
      try {
        scrubFile(filePath);
        candidate.scrubbedFiles.push(filePath);
      } catch (err: any) {
        log('warn', `failed to scrub ${filePath}: ${err?.message ?? String(err)}`);
      }
    }

    try {
      await runCommand(`git worktree remove --force ${shellEscape(candidate.path)}`, { cwd: repoRoot });
    } catch (err: any) {
      log('warn', `git worktree remove failed for ${candidate.path}: ${err?.message ?? String(err)}`);
      try {
        rmSync(candidate.path, { recursive: true, force: true });
      } catch (rmErr: any) {
        log('warn', `rmSync fallback failed for ${candidate.path}: ${rmErr?.message ?? String(rmErr)}`);
      }
    }
  }

  await runCommand('git worktree prune', { cwd: repoRoot }).catch((err: any) =>
    log('warn', `git worktree prune failed in ${repoRoot}: ${err?.message ?? String(err)}`),
  );

  return { removed, kept, dryRun: false };
}

function computeAgeDays(worktreePath: string, now: () => number): number {
  try {
    const mtimeMs = statSync(join(worktreePath, '.git')).mtimeMs;
    return (now() - mtimeMs) / (24 * 60 * 60 * 1000);
  } catch {
    return Infinity;
  }
}

export function formatGcReport(report: GcReport): string {
  const lines: string[] = [];
  const verb = report.dryRun ? 'would remove' : 'removed';

  for (const candidate of report.removed) {
    const branchLabel = candidate.branch ?? 'detached';
    const age = Number.isFinite(candidate.ageDays) ? Math.floor(candidate.ageDays) : '∞';
    let line = `${candidate.path} (${branchLabel}, ${age}d old) — ${candidate.reason}`;
    if (candidate.scrubbedFiles.length > 0) {
      line += `, scrubbed ${candidate.scrubbedFiles.length} credential file(s)`;
    }
    lines.push(line);
  }

  lines.push(`${verb} ${report.removed.length} worktree(s), kept ${report.kept}`);

  return lines.join('\n');
}
