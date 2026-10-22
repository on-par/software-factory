// src/worktree/worktree-gc-scrub.ts — credential discovery and in-place scrub for reaped worktrees

import type { Dirent } from 'node:fs';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const CREDENTIAL_BASENAMES = new Set(['.git-credentials', '.npmrc']);

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
        // lstat, not stat: a symlinked `.env` must never lead the scrub outside the worktree.
        if (lstatSync(filePath).isFile()) found.push(filePath);
      } catch {}
    }
  }

  const claudeDir = join(worktreePath, '.claude');
  if (isRealDirectory(claudeDir)) {
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

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Zero a file in place through one fd opened with O_NOFOLLOW. The worktree's agent can swap
 *  a credential file for a symlink after `findCredentialFiles` walks it; a path-based
 *  stat + write would then zero the link's target (e.g. `~/.ssh/id_*`). Throws ELOOP on a
 *  symlink and refuses anything that is not a regular file. */
export function zeroFill(filePath: string): void {
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`refusing to zero-fill non-regular file ${filePath}`);
    const zeros = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    let offset = 0;
    while (offset < stat.size) {
      offset += writeSync(fd, zeros, 0, Math.min(zeros.length, stat.size - offset), offset);
    }
  } finally {
    closeSync(fd);
  }
}

/** Zero-fill then delete. A symlink is unlinked without zeroing — rm removes the link, never
 *  its target. */
export function scrubFile(filePath: string): void {
  try {
    zeroFill(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ELOOP') throw err;
  }
  rmSync(filePath, { force: true });
}
