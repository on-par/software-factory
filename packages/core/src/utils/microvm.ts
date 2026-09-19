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
import { homedir } from 'node:os';
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
  /** Egress allowlist rendered into the microVM's network policy at create time
   *  (the resolved sandbox config's `network.allow`). Empty = deny all egress. */
  allowHosts: string[];
  exec?: ExecFn;
  isAvailable?: (cmd: string) => boolean;
}

/** Builds the `WorktreeSandbox` descriptor for a resolved sandbox runtime, or
 *  undefined for every runtime but docker-sandbox — the only one with a microVM
 *  lifecycle. Shared by shipIssue/landIssue so both derive the same authPaths
 *  from one place instead of re-deriving them inline (#653). */
export function worktreeSandboxFor(
  runtime: SandboxRuntime | undefined,
  opts: { homedir?: string; allowHosts?: string[] } = {},
): WorktreeSandbox | undefined {
  if (runtime !== 'docker-sandbox') return undefined;
  const home = opts.homedir ?? homedir();
  return {
    runtime: 'docker-sandbox',
    authPaths: [resolve(home, '.claude'), resolve(home, '.codex'), resolve(home, '.npm')],
    allowHosts: opts.allowHosts ?? [],
  };
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
  const network =
    opts.allowHosts.length > 0
      ? opts.allowHosts.map((h) => `--allow-network ${shellQuote(h)}`).join(' ')
      : '--network none';
  const cmd = ['sbx create', `--name ${name}`, mounts, network].filter(Boolean).join(' ');
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

async function sbxRemove(name: string, exec: ExecFn): Promise<void> {
  await exec(`sbx rm --force ${name}`, { timeoutMs: MICRO_VM_TIMEOUT_MS });
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
    await sbxRemove(name, exec);
    opts.log?.('sandbox', `microVM ${name} removed for ${opts.worktreePath}`);
  } catch {
    // Best-effort — an already-gone or unreachable VM must not fail worktree cleanup.
  }
}

export interface ReapedMicroVm {
  name: string;
  removed: boolean;
  detail: string;
}

/** Lists every `factory-*` sbx microVM name currently known to `sbx list`, regardless of
 *  which (if any) lane still owns it — callers cross-reference against active port leases
 *  to determine orphan-ness. Returns `[]` (never throws) when `sbx` is not on PATH or the
 *  listing itself fails, consistent with how the rest of `factory doctor` treats an absent
 *  optional tool. */
export async function listMicroVms(
  opts: { exec?: ExecFn; isAvailable?: (cmd: string) => boolean } = {},
): Promise<string[]> {
  const isAvailable = opts.isAvailable ?? isCommandAvailable;
  if (!isAvailable('sbx')) return [];

  const exec = opts.exec ?? defaultExecFn;
  try {
    const { stdout } = await exec('sbx list', { timeoutMs: MICRO_VM_TIMEOUT_MS });
    return stdout
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((name): name is string => !!name && name.startsWith(MICRO_VM_NAME_PREFIX));
  } catch {
    return [];
  }
}

/** Removes one orphan sbx VM by its already-known name (unlike `removeMicroVm`, which only
 *  knows a worktree path and re-derives the name — reconcile discovers orphans by name via
 *  `listMicroVms`, and the whole point is that their original worktree may already be
 *  gone). Never throws: a failure is reported in the returned row so the caller can still
 *  act on every VM and let the doctor check surface the failure. */
export async function reapOrphanMicroVm(name: string, opts: { exec?: ExecFn } = {}): Promise<ReapedMicroVm> {
  const exec = opts.exec ?? defaultExecFn;
  try {
    await sbxRemove(shellQuote(name), exec);
    return { name, removed: true, detail: `sbx rm --force ${name} ok` };
  } catch (err: any) {
    return {
      name,
      removed: false,
      detail: `sbx rm --force ${name} failed: ${err?.stderr ?? err?.message ?? String(err)}`,
    };
  }
}
