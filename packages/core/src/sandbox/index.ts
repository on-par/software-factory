// src/sandbox/index.ts — OS-level containment for agentic BUILD/rework runs.
//
// v1 wraps the underlying claude/codex CLI invocation in a platform sandbox
// (macOS sandbox-exec, Linux firejail) that restricts filesystem writes to the
// worktree + known state dirs and gates network by an allowlist. Per-host
// network filtering is not expressible in either runtime without a proxy —
// see resolveSandboxPolicy's caller for the 'sandbox-degraded' warning this
// implies when the allowlist is non-empty. `docker-sandbox` is a selectable
// runtime name for the future microVM runtime (#653); it is not a command
// prefix and wraps nothing until that lifecycle lands.

import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { FactoryConfig } from '../config/index.js';
import { HarnessError } from '../harness/index.js';
import { isCommandAvailable } from '../models/index.js';
import { shellEscape } from '../utils/index.js';

export type SandboxRuntime = 'sandbox-exec' | 'firejail' | 'docker-sandbox' | 'none';

/** The configurable form of SandboxRuntime: the concrete runtimes plus 'auto',
 *  which defers to host detection. This is what `sandbox.runtime` in
 *  .factory/config.json and FACTORY_SANDBOX_RUNTIME accept. */
export type SandboxRuntimeSetting = SandboxRuntime | 'auto';

const SANDBOX_RUNTIME_SETTINGS: readonly SandboxRuntimeSetting[] = [
  'auto',
  'sandbox-exec',
  'firejail',
  'docker-sandbox',
  'none',
];

export interface SandboxPolicy {
  runtime: SandboxRuntime;
  worktree: string;
  /** Absolute paths the agent may write (worktree, repo .git, tmp, agent state dirs). */
  writablePaths: string[];
  /** Absolute path PREFIXES the agent may write. Covers a home-root state file plus the
   *  sibling temp/backup files an atomic write creates — e.g. ~/.claude.json,
   *  ~/.claude.json.backup, ~/.claude.json.tmp.<pid>.<hash> (#1008). A subpath rule does
   *  NOT cover those siblings, which is why this is a separate field. */
  writableFilePrefixes: string[];
  allowHosts: string[];
  cpuMs: number;
  memMb: number;
}

export type SandboxEventType = 'sandbox_violation' | 'resource_limit' | 'sandbox_auth_denied';

/** Which sandbox runtime (if any) is usable on this host.
 *  `includeDockerSandbox` is opt-in and defaults to false: docker-sandbox has no VM
 *  lifecycle yet (#653), so the `auto` path must never select it — see the ADR. */
export function detectSandboxRuntime(
  platform: NodeJS.Platform,
  isAvailable: (cmd: string) => boolean = isCommandAvailable,
  opts: { includeDockerSandbox?: boolean } = {},
): SandboxRuntime {
  if (opts.includeDockerSandbox === true && isAvailable('sbx')) return 'docker-sandbox';
  if (platform === 'darwin' && isAvailable('sandbox-exec')) return 'sandbox-exec';
  if (platform === 'linux' && isAvailable('firejail')) return 'firejail';
  return 'none';
}

function sandboxRuntimeFromEnv(env: NodeJS.ProcessEnv): SandboxRuntimeSetting | undefined {
  const raw = env.FACTORY_SANDBOX_RUNTIME;
  return SANDBOX_RUNTIME_SETTINGS.find((s) => s === raw);
}

/** Resolves the concrete runtime for one run. FACTORY_SANDBOX_RUNTIME wins over the
 *  config field (mirroring FACTORY_SANDBOX over `sandbox.enabled`); an unrecognized env
 *  value is ignored, exactly as FACTORY_SANDBOX ignores anything that is not 0 or 1.
 *  Only 'auto' probes the host — an explicit runtime is honored verbatim so an operator
 *  opting into docker-sandbox is never silently downgraded. */
export function resolveSandboxRuntime(
  configured: SandboxRuntimeSetting | undefined,
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    isAvailable?: (cmd: string) => boolean;
  } = {},
): SandboxRuntime {
  const env = opts.env ?? process.env;
  const setting = sandboxRuntimeFromEnv(env) ?? configured ?? 'auto';
  if (setting !== 'auto') return setting;
  return detectSandboxRuntime(opts.platform ?? process.platform, opts.isAvailable ?? isCommandAvailable);
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

  const runtime = resolveSandboxRuntime(cfg.runtime, { env, platform, isAvailable });

  const writablePaths = dedupeAbsolutePaths([
    opts.worktree,
    resolve(opts.repoRoot, '.git'),
    tmp,
    resolve(home, '.claude'),
    resolve(home, '.codex'),
    resolve(home, '.openclaw'),
    resolve(home, '.npm'),
    resolve(home, '.cache'),
    resolve(home, '.config'),
    resolve(home, '.local'),
    ...(platform === 'darwin'
      ? [
          '/tmp',
          '/private/tmp',
          '/private/var/folders',
          resolve(home, 'Library/Caches'),
          resolve(home, 'Library/Logs'),
          resolve(home, 'Library/Keychains'),
        ]
      : []),
  ]);

  const writableFilePrefixes = dedupeAbsolutePaths([resolve(home, '.claude.json')]);

  return {
    runtime,
    worktree: opts.worktree,
    writablePaths,
    writableFilePrefixes,
    allowHosts: cfg.network.allow,
    cpuMs: cfg.resources.cpuMs,
    memMb: cfg.resources.memMb,
  };
}

function sbplPath(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Anchored SBPL regex literal for a writable path prefix. Regex-escape first, then
 *  escape for the SBPL string literal (backslashes are doubled so they survive to the
 *  regex engine) — backslash and quote are escaped in a single pass so the quote step
 *  can never see (and re-escape) a backslash the backslash step just inserted. */
function sbplRegexPrefix(path: string): string {
  const escaped = path.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&');
  const sbplEscaped = escaped.replace(/[\\"]/g, (ch) => (ch === '\\' ? '\\\\' : '\\"'));
  return `#"^${sbplEscaped}"`;
}

/** Renders the macOS Seatbelt (SBPL) profile for a resolved policy. */
export function buildDarwinProfile(policy: SandboxPolicy): string {
  const writeRules = policy.writablePaths.map((p) => `(allow file-write* (subpath ${sbplPath(p)}))`).join('\n');
  const prefixRules = policy.writableFilePrefixes
    .map((p) => `(allow file-write* (regex ${sbplRegexPrefix(p)}))`)
    .join('\n');
  const networkDeny = policy.allowHosts.length === 0 ? '\n(deny network-outbound)' : '';

  return `(version 1)
(allow default)
(deny file-write*)
${writeRules}
${prefixRules}
(allow file-write* (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))${networkDeny}`;
}

/** Wraps `cmd` with the platform sandbox + resource-limit prefix. Pure —
 *  runtime 'none' returns cmd unchanged. */
export function wrapCommandInSandbox(cmd: string, policy: SandboxPolicy): string {
  // docker-sandbox is a VM runtime, not a command prefix; its lifecycle lands in #653.
  // Until then it wraps nothing — and must never fall through to the firejail branch below.
  if (policy.runtime === 'none' || policy.runtime === 'docker-sandbox') return cmd;

  const cpuSeconds = Math.ceil(policy.cpuMs / 1000);
  const ulimitPrefix =
    policy.runtime === 'firejail' ? `ulimit -t ${cpuSeconds} -v ${policy.memMb * 1024}` : `ulimit -t ${cpuSeconds}`;
  const inner = `/bin/sh -c ${shellEscape(`${ulimitPrefix}; ${cmd}`)}`;

  if (policy.runtime === 'sandbox-exec') {
    return `sandbox-exec -p ${shellEscape(buildDarwinProfile(policy))} ${inner}`;
  }

  const writeFlags = [...policy.writablePaths, ...policy.writableFilePrefixes]
    .map((p) => `--read-write=${shellEscape(p)}`)
    .join(' ');
  const netFlag = policy.allowHosts.length === 0 ? ' --net=none' : '';
  return `firejail --quiet --noprofile --private-tmp --read-only=/ ${writeFlags}${netFlag} -- ${inner}`;
}

const RESOURCE_LIMIT_STDERR = /cpu time limit exceeded/i;
const SANDBOX_VIOLATION_STDERR = /operation not permitted|read-only file system|sandbox.*deny|deny\(1\) file-write/i;
const LOCAL_AUTH_TEXT = /failed to authenticate|oauth session expired|could not be refreshed|please (run )?\/?login/i;

/** Classifies a harness failure as a sandbox-caused event, or undefined when
 *  it isn't one. Reads stderr/stdout/signal off both plain exec errors and
 *  HarnessError.details. This is only ever called by the router when a
 *  sandbox is active (packages/core/src/router/index.ts, the `if (sandbox)`
 *  guard), so an auth failure it sees is by construction a failure under
 *  containment, not a bare provider auth problem. */
export function sandboxEventFromError(err: unknown): { type: SandboxEventType; detail: string } | undefined {
  let stderr = '';
  let stdout = '';
  let signal: string | undefined;
  let reason: string | undefined;

  if (err instanceof HarnessError) {
    stderr = err.details.stderr ?? '';
    stdout = err.details.stdout ?? '';
    signal = err.details.signal;
    reason = err.reason;
  } else if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; stdout?: unknown; signal?: unknown };
    stderr = typeof e.stderr === 'string' ? e.stderr : '';
    stdout = typeof e.stdout === 'string' ? e.stdout : '';
    signal = typeof e.signal === 'string' ? e.signal : undefined;
  }

  const text = [stderr, stdout].filter(Boolean).join('\n');

  if (signal === 'SIGXCPU' || RESOURCE_LIMIT_STDERR.test(stderr)) {
    return { type: 'resource_limit', detail: stderr || `signal ${signal}` };
  }
  if (reason === 'local_auth' || LOCAL_AUTH_TEXT.test(text)) {
    return { type: 'sandbox_auth_denied', detail: text || 'claude reported local_auth under the sandbox' };
  }
  if (SANDBOX_VIOLATION_STDERR.test(stderr)) {
    return { type: 'sandbox_violation', detail: stderr };
  }
  return undefined;
}
