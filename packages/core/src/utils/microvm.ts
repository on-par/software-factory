import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { EventKind } from '../events/kinds.js';
import { isCommandAvailable } from '../models/index.js';
import type { SandboxRuntime } from '../sandbox/index.js';
import { claudeConfigDirOverride } from './claude-config.js';
import { defaultExecFn, type ExecFn } from './exec.js';

const MICRO_VM_NAME_PREFIX = 'factory-';
const MICRO_VM_TIMEOUT_MS = 60_000;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function microVmName(worktreePath: string): string {
  return `${MICRO_VM_NAME_PREFIX}${createHash('sha256').update(resolve(worktreePath)).digest('hex').slice(0, 12)}`;
}

export interface WorktreeSandbox {
  runtime: SandboxRuntime;
  authPaths: string[];
  allowHosts: string[];
  exec?: ExecFn;
  isAvailable?: (cmd: string) => boolean;
}

export function worktreeSandboxFor(
  runtime: SandboxRuntime | undefined,
  opts: { homedir?: string; allowHosts?: string[]; env?: NodeJS.ProcessEnv } = {},
): WorktreeSandbox | undefined {
  if (runtime !== 'docker-sandbox') return undefined;
  const home = opts.homedir ?? homedir();
  const claudeProfileDir = claudeConfigDirOverride(opts.env ?? process.env);
  return {
    runtime: 'docker-sandbox',
    authPaths: [
      resolve(home, '.claude'),
      ...(claudeProfileDir ? [resolve(claudeProfileDir)] : []),
      resolve(home, '.codex'),
      resolve(home, '.npm'),
    ],
    allowHosts: opts.allowHosts ?? [],
  };
}

export interface MicroVmLifecycleOptions extends WorktreeSandbox {
  worktreePath: string;
  log?: (type: EventKind, msg: string) => void;
}

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

export async function removeMicroVm(opts: MicroVmLifecycleOptions): Promise<void> {
  if (opts.runtime !== 'docker-sandbox') return;

  const isAvailable = opts.isAvailable ?? isCommandAvailable;
  if (!isAvailable('sbx')) return;

  const name = microVmName(opts.worktreePath);
  const exec = opts.exec ?? defaultExecFn;

  try {
    await sbxRemove(name, exec);
    opts.log?.('sandbox', `microVM ${name} removed for ${opts.worktreePath}`);
  } catch {}
}

export interface ReapedMicroVm {
  name: string;
  removed: boolean;
  detail: string;
}

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
