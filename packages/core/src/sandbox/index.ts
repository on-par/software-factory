// src/sandbox/index.ts — OS-level containment for agentic BUILD/rework runs.
//
// v1 wraps the underlying claude/codex CLI invocation in a platform sandbox
// (macOS sandbox-exec, Linux firejail) that restricts filesystem writes to the
// worktree + known state dirs and gates network by an allowlist. Per-host
// network filtering is not expressible in either runtime without a proxy —
// see resolveSandboxPolicy's caller for the 'sandbox-degraded' warning this
// implies when the allowlist is non-empty.

import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { FactoryConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { isCommandAvailable } from '../models/index.js';
import { shellEscape } from '../utils/index.js';

export type SandboxRuntime = 'sandbox-exec' | 'firejail' | 'none';

export interface SandboxPolicy {
  runtime: SandboxRuntime;
  worktree: string;
  /** Absolute paths the agent may write (worktree, repo .git, tmp, agent state dirs). */
  writablePaths: string[];
  allowHosts: string[];
  cpuMs: number;
  memMb: number;
}

export type SandboxEventType = 'sandbox_violation' | 'resource_limit';

/** Which sandbox runtime (if any) is usable on this host. */
export function detectSandboxRuntime(
  platform: NodeJS.Platform,
  isAvailable: (cmd: string) => boolean = isCommandAvailable,
): SandboxRuntime {
  if (platform === 'darwin' && isAvailable('sandbox-exec')) return 'sandbox-exec';
  if (platform === 'linux' && isAvailable('firejail')) return 'firejail';
  return 'none';
}

function sandboxDisabled(
  cfg: FactoryConfig['sandbox'],
  cliDisabled: boolean | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (cliDisabled) return true;
  if (env.FACTORY_SANDBOX === '0') return true;
  if (env.FACTORY_SANDBOX === '1') return false;
  return cfg.enabled === false;
}

function dedupeAbsolutePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((p) => p.length > 0))];
}

/** Resolves the containment policy for one agentic run, or undefined when the
 *  sandbox is off (explicit opt-out, env kill-switch, or config). */
export function resolveSandboxPolicy(
  cfg: FactoryConfig['sandbox'],
  opts: {
    worktree: string;
    repoRoot: string;
    cliDisabled?: boolean;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    isAvailable?: (cmd: string) => boolean;
    homedir?: string;
    tmpdir?: string;
  },
): SandboxPolicy | undefined {
  const env = opts.env ?? process.env;
  if (sandboxDisabled(cfg, opts.cliDisabled, env)) return undefined;

  const platform = opts.platform ?? process.platform;
  const isAvailable = opts.isAvailable ?? isCommandAvailable;
  const home = opts.homedir ?? homedir();
  const tmp = opts.tmpdir ?? tmpdir();

  const runtime = detectSandboxRuntime(platform, isAvailable);

  const writablePaths = dedupeAbsolutePaths([
    opts.worktree,
    resolve(opts.repoRoot, '.git'),
    tmp,
    resolve(home, '.claude'),
    resolve(home, '.codex'),
    resolve(home, '.npm'),
    resolve(home, '.cache'),
    resolve(home, '.config'),
    resolve(home, '.local'),
    ...(platform === 'darwin'
      ? ['/tmp', '/private/tmp', '/private/var/folders', resolve(home, 'Library/Caches'), resolve(home, 'Library/Logs')]
      : []),
  ]);

  return {
    runtime,
    worktree: opts.worktree,
    writablePaths,
    allowHosts: cfg.network.allow,
    cpuMs: cfg.resources.cpuMs,
    memMb: cfg.resources.memMb,
  };
}

function sbplPath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Renders the macOS Seatbelt (SBPL) profile for a resolved policy. */
export function buildDarwinProfile(policy: SandboxPolicy): string {
  const writeRules = policy.writablePaths.map((p) => `(allow file-write* (subpath ${sbplPath(p)}))`).join('\n');
  const networkDeny = policy.allowHosts.length === 0 ? '\n(deny network-outbound)' : '';

  return `(version 1)
(allow default)
(deny file-write*)
${writeRules}
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))${networkDeny}`;
}

/** Wraps `cmd` with the platform sandbox + resource-limit prefix. Pure —
 *  runtime 'none' returns cmd unchanged. */
export function wrapCommandInSandbox(cmd: string, policy: SandboxPolicy): string {
  if (policy.runtime === 'none') return cmd;

  const cpuSeconds = Math.ceil(policy.cpuMs / 1000);
  const ulimitPrefix =
    policy.runtime === 'firejail' ? `ulimit -t ${cpuSeconds} -v ${policy.memMb * 1024}` : `ulimit -t ${cpuSeconds}`;
  const inner = `/bin/sh -c ${shellEscape(`${ulimitPrefix}; ${cmd}`)}`;

  if (policy.runtime === 'sandbox-exec') {
    return `sandbox-exec -p ${shellEscape(buildDarwinProfile(policy))} ${inner}`;
  }

  const writeFlags = policy.writablePaths.map((p) => `--read-write=${shellEscape(p)}`).join(' ');
  const netFlag = policy.allowHosts.length === 0 ? ' --net=none' : '';
  return `firejail --quiet --noprofile --private-tmp --read-only=/ ${writeFlags}${netFlag} -- ${inner}`;
}

const RESOURCE_LIMIT_STDERR = /cpu time limit exceeded/i;
const SANDBOX_VIOLATION_STDERR = /operation not permitted|read-only file system|sandbox.*deny|deny\(1\) file-write/i;

/** Classifies a harness failure as a sandbox-caused event, or undefined when
 *  it isn't one. Reads stderr/signal off both plain exec errors and
 *  HarnessError.details. */
export function sandboxEventFromError(err: unknown): { type: SandboxEventType; detail: string } | undefined {
  let stderr = '';
  let signal: string | undefined;

  if (err instanceof HarnessError) {
    stderr = err.details.stderr ?? '';
    signal = err.details.signal;
  } else if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; signal?: unknown };
    stderr = typeof e.stderr === 'string' ? e.stderr : '';
    signal = typeof e.signal === 'string' ? e.signal : undefined;
  }

  if (signal === 'SIGXCPU' || RESOURCE_LIMIT_STDERR.test(stderr)) {
    return { type: 'resource_limit', detail: stderr || `signal ${signal}` };
  }
  if (SANDBOX_VIOLATION_STDERR.test(stderr)) {
    return { type: 'sandbox_violation', detail: stderr };
  }
  return undefined;
}
