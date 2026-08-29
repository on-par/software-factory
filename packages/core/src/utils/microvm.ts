// src/utils/microvm.ts — docker-sandbox (Docker Sandboxes / `sbx`) microVM lifecycle.
//
// Unlike sandbox-exec/firejail, which wrap a single command, docker-sandbox manages a
// lane-lifetime microVM: create it once when the lane's worktree is provisioned, tear it
// down once when the worktree is cleaned up. This module owns that create/remove pair,
// keyed by a deterministic hash of the worktree's absolute path so cleanup always targets
// exactly the VM setup created and re-entrant setup (e.g. landOpenPullRequest
// re-provisioning) is idempotent.
//
// A leaf module: does not import ./index.js (which would create a cycle back here), so
// shellQuote is duplicated (mirrors utils/index.ts's shellEscape) rather than imported.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import { isCommandAvailable } from '../models/index.js';
import type { SandboxRuntime } from '../sandbox/index.js';
import { defaultExecFn, type ExecFn } from './exec.js';

const MICRO_VM_NAME_PREFIX = 'factory-';
const MICRO_VM_TIMEOUT_MS = 60_000;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Deterministic, name-safe VM identity for a lane's worktree — unique per absolute
 *  path, stable across setup and cleanup calls for the same lane. */
export function microVmName(worktreePath: string): string {
  return `${MICRO_VM_NAME_PREFIX}${createHash('sha256').update(resolve(worktreePath)).digest('hex').slice(0, 12)}`;
}

/** The sandbox descriptor callers thread through setupWorktree/cleanupWorktree.
 *  `authPaths` is the resolved set of auth dirs (~/.claude, ~/.codex, ~/.npm) mounted
 *  read-write so contained agent runs can authenticate. */
export interface WorktreeSandbox {
  runtime: SandboxRuntime;
  authPaths: string[];
  exec?: ExecFn;
  isAvailable?: (cmd: string) => boolean;
}

export interface MicroVmLifecycleOptions extends WorktreeSandbox {
  worktreePath: string;
  log?: (type: EventKind, msg: string) => void;
}

/** Creates the microVM for a docker-sandbox lane, mounting the worktree as writable
 *  root plus the auth dirs. Never throws: an unavailable `sbx` binary or a failed
 *  create logs a fallback event and resolves `false` so the lane runs uncontained
 *  rather than failing outright. */
export async function createMicroVm(opts: MicroVmLifecycleOptions): Promise<boolean> {
  if (opts.runtime !== 'docker-sandbox') return false;

  const isAvailable = opts.isAvailable ?? isCommandAvailable;
  if (!isAvailable('sbx')) {
    opts.log?.(
      'sandbox-unavailable',
      `sbx not installed — docker-sandbox lane ${opts.worktreePath} falling back, running uncontained`,
    );
    return false;
  }

  // Best-effort pre-clean: a stale VM of the same name (re-entrant setup) must never
  // block create.
  await removeMicroVm(opts).catch(() => {});

  const name = microVmName(opts.worktreePath);
  const mounts = [opts.worktreePath, ...opts.authPaths].map((p) => `--mount ${shellQuote(p)}:rw`).join(' ');
  const cmd = `sbx create --name ${name} ${mounts}`;
  const exec = opts.exec ?? defaultExecFn;

  try {
    await exec(cmd, { timeoutMs: MICRO_VM_TIMEOUT_MS });
    opts.log?.('sandbox', `microVM ${name} created for ${opts.worktreePath}`);
    return true;
  } catch (err: any) {
    opts.log?.(
      'sandbox-unavailable',
      `sbx create failed for ${opts.worktreePath} — falling back, running uncontained: ${(err?.stderr ?? err?.message ?? String(err)).toString().trim()}`,
    );
    return false;
  }
}

/** Removes the microVM for a docker-sandbox lane. Best-effort and idempotent: `--force`
 *  tolerates an already-gone VM, and any exec failure is swallowed so cleanup never
 *  throws and never leaves the caller unable to finish tearing down the worktree. */
export async function removeMicroVm(opts: MicroVmLifecycleOptions): Promise<void> {
  if (opts.runtime !== 'docker-sandbox') return;

  const isAvailable = opts.isAvailable ?? isCommandAvailable;
  if (!isAvailable('sbx')) return;

  const name = microVmName(opts.worktreePath);
  const exec = opts.exec ?? defaultExecFn;

  try {
    await exec(`sbx rm --force ${name}`, { timeoutMs: MICRO_VM_TIMEOUT_MS });
    opts.log?.('sandbox', `microVM ${name} removed for ${opts.worktreePath}`);
  } catch {
    // Best-effort — an already-gone or unreachable VM must not fail worktree cleanup.
  }
}
