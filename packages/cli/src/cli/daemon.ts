// packages/cli/src/cli/daemon.ts — factory daemon start|stop|status|logs: launchctl
// wrappers around the foreground factoryd (#1179, epic #764), plus `daemon run`
// option resolution into FactorydConfig (#2128).

import { execFile } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

import {
  DEFAULT_FACTORYD_PORT,
  defaultRegistryPath,
  listRepos,
  loadRegistry,
  readRunLockHolder,
  type RepoState,
  type RunRuntime,
} from '@on-par/factory-core/internal';
import { defaultIsPidAlive, getFactoryPaths } from '@on-par/factory-core';

import { runSelfUpdateCommand } from './self-update-exec.js';
import {
  initialUpdateState,
  readUpdateState,
  recordUpdateCheck,
  writeUpdateState,
  type UpdateLastResult,
  type UpdateState,
} from './update-state.js';

export const FACTORYD_LABEL = 'com.onpar.factoryd';

/** Expected daemon-control failure. index.ts's commander wrappers map it onto
 *  CliExitError (importing CliExitError here would be circular — index.ts
 *  imports this module). */
export class DaemonCtlError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'DaemonCtlError';
  }
}

export type LaunchctlExec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface DaemonCtlDeps {
  /** Runs launchctl / ps without a shell. Default: promisified execFile that
   *  never rejects on non-zero exit (resolves { code, stdout, stderr }). */
  exec?: LaunchctlExec;
  /** Default os.homedir(). Tests point this at a temp dir. */
  home?: string;
  /** Default process.getuid?.() ?? 0. */
  uid?: number;
  /** Default process.platform. */
  platform?: NodeJS.Platform;
  /** Default process.stdout. */
  out?: { write(s: string): unknown };
  /** Default process.execPath. */
  nodePath?: string;
  /** Default realpathSync(process.argv[1]) — unwraps the bin symlink. */
  cliScriptPath?: string;
  /** Default defaultRegistryPath(). */
  registryFile?: string;
  /** Follow-mode poll interval; tests pass ~10. Default 250. */
  pollMs?: number;
}

/** Where a given home directory keeps the LaunchAgent plist and the daemon log. */
export function factorydFiles(home: string): { launchAgentsDir: string; plistPath: string; logPath: string } {
  const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
  return {
    launchAgentsDir,
    plistPath: join(launchAgentsDir, `${FACTORYD_LABEL}.plist`),
    logPath: join(home, '.factory', 'daemon.log'),
  };
}

export const UPDATE_MODES = ['manual', 'stable', 'prerelease'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];
export type UpdateChannel = 'latest' | 'next';

/** The single mode → npm dist-tag mapping (#2246). */
export function updateChannel(mode: UpdateMode): UpdateChannel | null {
  switch (mode) {
    case 'stable':
      return 'latest';
    case 'prerelease':
      return 'next';
    case 'manual':
      return null;
  }
}

/** Exact, case-sensitive parse of an update mode. Throws DaemonCtlError (code 2). */
export function parseUpdateMode(value: string, source: string): UpdateMode {
  if ((UPDATE_MODES as readonly string[]).includes(value)) return value as UpdateMode;
  throw new DaemonCtlError(`invalid ${source} "${value}" — expected one of ${UPDATE_MODES.join(', ')}`, 2);
}

export type InstallKind = 'npm-global' | 'source' | 'unknown';
export interface InstallInfo {
  kind: InstallKind;
  prefix: string;
  version: string;
}
export interface DetectInstallDeps {
  execPath?: string;
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  version?: string;
  exists?: (p: string) => boolean;
}

function defaultCliPath(): string {
  try {
    return realpathSync(process.argv[1] ?? '');
  } catch {
    return '';
  }
}

/** Classifies the running cli.js as npm-global, source or unknown (#2246). Pure
 *  apart from the injectable fs probe; never spawns npm or git. */
export function detectInstall(deps: DetectInstallDeps = {}): InstallInfo {
  const execPath = deps.execPath ?? process.execPath;
  const cliPath = deps.cliPath ?? defaultCliPath();
  const env = deps.env ?? process.env;
  const version = deps.version ?? (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
  const exists = deps.exists ?? existsSync;
  const prefix = dirname(dirname(execPath));
  const info = (kind: InstallKind): InstallInfo => ({ kind, prefix, version });
  if (env.FACTORY_FROM_SOURCE === '1') return info('source');
  const pkgDir = join(prefix, 'lib', 'node_modules', '@on-par', 'factory-cli');
  if (cliPath.startsWith(pkgDir + sep)) return info('npm-global');
  if (cliPath !== '') {
    let dir = dirname(cliPath);
    for (;;) {
      if (exists(join(dir, '.git'))) return info('source');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return info('unknown');
}

/** Optional daemon-scoped config file (<registry dir>/daemon.json). */
export interface DaemonFileConfig {
  autoUpdate?: { mode?: string; checkIntervalMinutes?: unknown; drainTimeoutMinutes?: unknown };
}

/** Reads daemon.json. A missing file is `{}`; malformed structure throws DaemonCtlError (code 2). */
export function loadDaemonFileConfig(file: string): DaemonFileConfig {
  if (!existsSync(file)) return {};
  const fail = (reason: string) => new DaemonCtlError(`invalid daemon config ${file}: ${reason}`, 2);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw fail(err instanceof Error ? err.message : String(err));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw fail('expected a JSON object');
  const autoUpdate = (parsed as { autoUpdate?: unknown }).autoUpdate;
  if (
    autoUpdate !== undefined &&
    (typeof autoUpdate !== 'object' || autoUpdate === null || Array.isArray(autoUpdate))
  ) {
    throw fail('autoUpdate must be an object');
  }
  return parsed as DaemonFileConfig;
}

export interface ResolvedAutoUpdate {
  /** Effective mode (after the source/unknown downgrade). */
  mode: UpdateMode;
  /** Mode requested before the downgrade. */
  requestedMode: UpdateMode;
  channel: UpdateChannel | null;
  checkIntervalMinutes: number;
  drainTimeoutMinutes: number;
}

/** Resolved options for the foreground `factory daemon run` process. */
export interface FactorydConfig {
  /** Registry file served (default ~/.factory/registry.json). */
  registryFile: string;
  /** Port to bind on 127.0.0.1 (default DEFAULT_FACTORYD_PORT). */
  port: number;
  /** Resolved self-update setting (#2246). runAutoUpdateLoop acts on it (#1939). */
  autoUpdate: ResolvedAutoUpdate;
  install: InstallInfo;
  /** One-time startup notices (deprecation, downgrade); cmdFactoryd logs each once. */
  notices: string[];
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new DaemonCtlError(`invalid ${name} "${String(value)}" — expected a positive integer`, 2);
  }
  return value;
}

/** Resolves `factory daemon run` options into a FactorydConfig. Throws
 *  DaemonCtlError (code 2) on an invalid --port, --update-mode or daemon.json value. */
export function resolveFactorydConfig(
  opts: { port?: string; registry?: string; updateMode?: string; autoUpdate?: boolean },
  deps: { install?: InstallInfo; fileConfig?: DaemonFileConfig } = {},
): FactorydConfig {
  const port = opts.port === undefined ? DEFAULT_FACTORYD_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DaemonCtlError(`invalid --port "${opts.port}" — expected an integer 0-65535`, 2);
  }
  const install = deps.install ?? detectInstall();
  const fileAutoUpdate = (deps.fileConfig ?? {}).autoUpdate;
  const notices: string[] = [];
  if (opts.autoUpdate === true) notices.push('--auto-update is deprecated; use --update-mode stable');
  let requested: UpdateMode;
  if (opts.updateMode !== undefined) requested = parseUpdateMode(opts.updateMode, '--update-mode');
  else if (opts.autoUpdate === true) requested = 'stable';
  else if (fileAutoUpdate?.mode !== undefined) {
    requested = parseUpdateMode(String(fileAutoUpdate.mode), 'autoUpdate.mode in daemon.json');
  } else requested = install.kind === 'npm-global' ? 'stable' : 'manual';
  let mode = requested;
  if (install.kind !== 'npm-global' && requested !== 'manual') {
    notices.push(`update mode ${requested} needs an npm install; staying manual`);
    mode = 'manual';
  }
  const autoUpdate: ResolvedAutoUpdate = {
    mode,
    requestedMode: requested,
    channel: updateChannel(mode),
    checkIntervalMinutes: positiveInt(fileAutoUpdate?.checkIntervalMinutes, 30, 'autoUpdate.checkIntervalMinutes'),
    drainTimeoutMinutes: positiveInt(fileAutoUpdate?.drainTimeoutMinutes, 60, 'autoUpdate.drainTimeoutMinutes'),
  };
  return { registryFile: opts.registry ?? defaultRegistryPath(), port, autoUpdate, install, notices };
}

function xmlEscape(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Pure renderer for ~/Library/LaunchAgents/com.onpar.factoryd.plist. KeepAlive
 *  relaunches factoryd after any exit; RunAtLoad starts it at login/bootstrap;
 *  launchd redirects stdout+stderr to the daemon log. ProgramArguments invokes
 *  the foreground `factory daemon run` command with its defaults. */
export function renderFactorydPlist(opts: { nodePath: string; cliScriptPath: string; logPath: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${FACTORYD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(opts.nodePath)}</string>
    <string>${xmlEscape(opts.cliScriptPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
</dict>
</plist>
`;
}

/** Extracts the running pid from `launchctl print gui/<uid>/<label>` output. */
/** `factory daemon status --json` payload (#2267). Additive changes only; bump schemaVersion on a breaking change. */
export interface DaemonStatusJson {
  schemaVersion: 1;
  running: boolean;
  pid: number | null;
  uptimeSec: number | null;
  plistInstalled: boolean;
  repos: Array<{ slug: string; checkoutPath: string; state: RepoState }>;
}

/** ps `etime` ([[dd-]hh:]mm:ss) → whole seconds; null when empty or malformed. */
export function parseEtime(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  const [, dd, hh, mm, ss] = m;
  if (dd !== undefined && hh === undefined) return null;
  return ((Number(dd ?? 0) * 24 + Number(hh ?? 0)) * 60 + Number(mm)) * 60 + Number(ss);
}

export function parseLaunchctlPid(printOutput: string): number | null {
  const m = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(printOutput);
  return m ? Number(m[1]) : null;
}

/** Last n lines of text, ignoring a trailing newline. */
export function lastLines(text: string, n: number): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-n);
}

/** The production exec seam: execFile without a shell, resolving (never
 *  rejecting) `{ code, stdout, stderr }` — a missing binary or non-numeric
 *  error code becomes code 1. Exported for direct coverage in daemon.test.ts. */
export function defaultExec(): LaunchctlExec {
  return (cmd, args) =>
    new Promise((res) => {
      execFile(cmd, args, (error, stdout, stderr) => {
        const code = error ? (((error as { code?: unknown }).code as number | undefined) ?? 1) : 0;
        res({ code: typeof code === 'number' ? code : 1, stdout, stderr });
      });
    });
}

interface ResolvedDeps {
  exec: LaunchctlExec;
  home: string;
  uid: number;
  platform: NodeJS.Platform;
  out: { write(s: string): unknown };
  nodePath: string;
  cliScriptPath: string;
  registryFile: string;
  pollMs: number;
}

function resolveDeps(deps: DaemonCtlDeps): ResolvedDeps {
  return {
    exec: deps.exec ?? defaultExec(),
    home: deps.home ?? homedir(),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    platform: deps.platform ?? process.platform,
    out: deps.out ?? process.stdout,
    nodePath: deps.nodePath ?? process.execPath,
    cliScriptPath: deps.cliScriptPath ?? realpathSync(process.argv[1] ?? ''),
    registryFile: deps.registryFile ?? defaultRegistryPath(),
    pollMs: deps.pollMs ?? 250,
  };
}

function requireDarwin(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') {
    throw new DaemonCtlError('factory daemon start|stop|status requires macOS launchd', 2);
  }
}

/** Install (or reinstall) and load the LaunchAgent. Always a full reinstall:
 *  regenerate the plist, bootout (ignoring failure — handles both "already
 *  loaded" and "not loaded"), then bootstrap into the gui domain so the daemon's
 *  Claude workers keep login-keychain access (docs/runbooks/macos-keychain-launchagent.md). */
export async function cmdDaemonStart(deps: DaemonCtlDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  requireDarwin(d.platform);
  const { launchAgentsDir, plistPath, logPath } = factorydFiles(d.home);

  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(plistPath, renderFactorydPlist({ nodePath: d.nodePath, cliScriptPath: d.cliScriptPath, logPath }));

  await d.exec('launchctl', ['bootout', `gui/${d.uid}/${FACTORYD_LABEL}`]);
  const boot = await d.exec('launchctl', ['bootstrap', `gui/${d.uid}`, plistPath]);
  if (boot.code !== 0) {
    throw new DaemonCtlError(
      `launchctl bootstrap failed: ${boot.stderr.trim() || boot.stdout.trim() || `exit ${boot.code}`}`,
      1,
    );
  }

  const print = await d.exec('launchctl', ['print', `gui/${d.uid}/${FACTORYD_LABEL}`]);
  const pid = parseLaunchctlPid(print.stdout);
  d.out.write(`factoryd: installed ${plistPath}\n`);
  d.out.write(
    pid === null ? 'factoryd: loaded — launchd will start it (RunAtLoad)\n' : `factoryd: running (pid ${pid})\n`,
  );
}

/** Unload the LaunchAgent. Idempotent: a not-loaded agent is success. The plist
 *  stays on disk so `factory daemon start` re-enables it. */
export async function cmdDaemonStop(deps: DaemonCtlDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  requireDarwin(d.platform);
  const res = await d.exec('launchctl', ['bootout', `gui/${d.uid}/${FACTORYD_LABEL}`]);
  if (res.code === 0) {
    d.out.write('factoryd: stopped (unloaded from launchd)\n');
  } else {
    d.out.write('factoryd: not loaded — already stopped\n');
  }
  d.out.write('  plist stays installed; `factory daemon start` re-enables it\n');
}

/** Report running/not-loaded, pid + uptime, plist install state, and the
 *  attached repos from the registry. Exit code 0 when running, 1 when not.
 *  With `opts.json`, print one DaemonStatusJson object instead of text. */
export async function cmdDaemonStatus(deps: DaemonCtlDeps = {}, opts: { json?: boolean } = {}): Promise<void> {
  const d = resolveDeps(deps);
  requireDarwin(d.platform);
  const { plistPath, logPath } = factorydFiles(d.home);

  if (opts.json) {
    const printed = await d.exec('launchctl', ['print', `gui/${d.uid}/${FACTORYD_LABEL}`]);
    const pid = printed.code === 0 ? parseLaunchctlPid(printed.stdout) : null;
    const uptimeSec =
      pid === null ? null : parseEtime((await d.exec('ps', ['-o', 'etime=', '-p', String(pid)])).stdout);
    const payload: DaemonStatusJson = {
      schemaVersion: 1,
      running: pid !== null,
      pid,
      uptimeSec,
      plistInstalled: existsSync(plistPath),
      repos: listRepos(await loadRegistry(d.registryFile)).map((r) => ({
        slug: r.slug,
        checkoutPath: r.path,
        state: r.state,
      })),
    };
    d.out.write(`${JSON.stringify(payload)}\n`);
    if (pid === null) process.exitCode = 1;
    return;
  }

  const print = await d.exec('launchctl', ['print', `gui/${d.uid}/${FACTORYD_LABEL}`]);
  if (print.code !== 0) {
    d.out.write('factoryd: not loaded\n');
    d.out.write(existsSync(plistPath) ? `  plist installed: ${plistPath}\n` : '  plist not installed\n');
    d.out.write('  run: factory daemon start\n');
    process.exitCode = 1;
  } else {
    const pid = parseLaunchctlPid(print.stdout);
    if (pid === null) {
      d.out.write('factoryd: loaded (not currently running)\n');
      process.exitCode = 1;
    } else {
      const ps = await d.exec('ps', ['-o', 'etime=', '-p', String(pid)]);
      const uptime = ps.stdout.trim() || 'unknown';
      d.out.write(`factoryd: running (pid ${pid}, uptime ${uptime})\n`);
    }
    d.out.write(`  plist: ${plistPath}\n`);
  }
  d.out.write(`  log: ${logPath}\n`);

  const registry = await loadRegistry(d.registryFile);
  const repos = listRepos(registry);
  if (repos.length === 0) {
    d.out.write('  attached repos: none\n');
  } else {
    d.out.write(`  attached repos (${repos.length}):\n`);
    for (const repo of repos) d.out.write(`    ${repo.slug} [${repo.state}]\n`);
  }
}

/** Print the last N lines of ~/.factory/daemon.log; with --follow, keep
 *  streaming appended bytes until Ctrl-C (size-offset poll, like logs.ts's
 *  followEvents — no `tail -f` child process). Works on any platform. */
export async function cmdDaemonLogs(
  opts: { follow?: boolean; lines?: string },
  deps: DaemonCtlDeps = {},
): Promise<void> {
  const d = resolveDeps(deps);
  const { logPath } = factorydFiles(d.home);
  const n = Number(opts.lines ?? '100');
  if (!Number.isInteger(n) || n < 0) {
    throw new DaemonCtlError(`invalid --lines "${opts.lines}" — expected a non-negative integer`, 2);
  }

  let initial: string;
  try {
    initial = readFileSync(logPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    d.out.write(`no daemon log yet at ${logPath} — is the daemon started?\n`);
    return;
  }

  const tail = lastLines(initial, n);
  if (tail.length > 0) d.out.write(tail.join('\n') + '\n');
  if (!opts.follow) return;

  let offset = Buffer.byteLength(initial);
  const poll = setInterval(() => {
    let fd: number;
    try {
      fd = openSync(logPath, 'r');
    } catch {
      return; // transiently missing (rotation) — keep polling
    }
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch {
      closeSync(fd);
      return;
    }
    if (size < offset) offset = 0; // truncated/rotated: start over
    if (size === offset) {
      closeSync(fd);
      return;
    }
    try {
      const buf = Buffer.alloc(size - offset);
      const read = readSync(fd, buf, 0, buf.length, offset);
      offset += read;
      d.out.write(buf.subarray(0, read).toString('utf-8'));
    } finally {
      closeSync(fd);
    }
  }, d.pollMs);

  await new Promise<void>((res) => {
    const done = () => res();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  clearInterval(poll);
}

// ── auto-update loop (#1939) ────────────────────────────────────────────────

/** Exit code that makes launchd KeepAlive / systemd Restart=always relaunch factoryd. */
export const AUTO_UPDATE_RESTART_EXIT_CODE = 75;
/** `factory self-update` exit code for "a run is active, refusing to apply". */
export const AUTO_UPDATE_BUSY_EXIT_CODE = 3;

export interface AutoUpdateCheck {
  candidate: string | null;
  updateAvailable: boolean;
  error: string | null;
}
export interface AutoUpdateApplyResult {
  code: number;
  rolledBack: boolean;
  error: string | null;
}
export type AutoUpdateOutcome =
  | 'manual'
  | 'check-error'
  | 'no-update'
  | 'skipped-failed-version'
  | 'preflight-failed'
  | 'drain-timeout'
  | 'busy'
  | 'failed'
  | 'updated';

export interface AutoUpdateDeps {
  stateFile: string;
  check(): Promise<AutoUpdateCheck>;
  apply(version: string): Promise<AutoUpdateApplyResult>;
  /** Proves the update command works (`self-update --to <v> --dry-run`) BEFORE any STOP is written (#2355). */
  preflight(version: string): Promise<AutoUpdateApplyResult>;
  /** Slugs/labels with an active run; empty = drained. */
  activeRuns(): Promise<string[]>;
  /** Exclusively creates STOP in every attached repo; returns only the paths it created. */
  writeStops(): Promise<string[]>;
  clearStops(files: string[]): Promise<void>;
  /** Epoch ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  exit(code: number): Promise<void> | void;
  /** Loop guard; default () => false. */
  stopped?(): boolean;
  /** Drain poll interval; default 30_000. */
  drainPollMs?: number;
}

type AutoUpdateConfig = Pick<FactorydConfig, 'autoUpdate' | 'install'>;

/** True only for an error-free, newer candidate; prereleases are ignored in stable mode. */
export function isUpdateCandidate(
  check: AutoUpdateCheck,
  mode: UpdateMode,
  current: string,
): check is AutoUpdateCheck & { candidate: string } {
  if (check.error !== null || !check.updateAvailable) return false;
  if (typeof check.candidate !== 'string' || check.candidate === '') return false;
  if (check.candidate === current) return false;
  if (mode === 'stable' && check.candidate.includes('-')) return false;
  return true;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One check → drain → apply pass. Never throws; never applies while a run is active. */
export async function runAutoUpdateCycle(config: AutoUpdateConfig, deps: AutoUpdateDeps): Promise<AutoUpdateOutcome> {
  const { mode, drainTimeoutMinutes } = config.autoUpdate;
  if (mode === 'manual') return 'manual';
  const iso = () => new Date(deps.now()).toISOString();
  const safeWrite = (state: UpdateState) => {
    try {
      writeUpdateState(deps.stateFile, state);
    } catch (err) {
      deps.log(`could not write ${deps.stateFile}: ${errorMessage(err)}`);
    }
  };

  let check: AutoUpdateCheck;
  try {
    check = await deps.check();
  } catch (err) {
    check = { candidate: null, updateAvailable: false, error: errorMessage(err) };
  }
  if (readUpdateState(deps.stateFile) === null) safeWrite(initialUpdateState(config, null));

  const eligible = isUpdateCandidate(check, mode, config.install.version);
  const candidate = eligible ? check.candidate : null;
  try {
    recordUpdateCheck(deps.stateFile, { at: iso(), available: candidate }, deps.log);
  } catch (err) {
    deps.log(`could not write ${deps.stateFile}: ${errorMessage(err)}`);
  }
  if (check.error !== null) {
    deps.log(`update check failed: ${check.error}`);
    return 'check-error';
  }
  if (candidate === null) return 'no-update';

  const state = readUpdateState(deps.stateFile) ?? initialUpdateState(config, null);
  const last = state.lastResult;
  if (last?.version === candidate && (last.outcome === 'failed' || last.outcome === 'rolled-back')) {
    deps.log(`update: skipping ${candidate} — previous attempt ${last.outcome}; waiting for a newer release`);
    return 'skipped-failed-version';
  }

  const finish = (result: Omit<UpdateLastResult, 'at' | 'version'>, extra: Partial<UpdateState> = {}) => {
    const latest = readUpdateState(deps.stateFile) ?? state;
    safeWrite({
      ...latest,
      ...extra,
      lastResult: { at: iso(), version: candidate, ...result },
      draining: null,
    });
  };

  // Preflight before draining: an unsupported or broken update command must never stop builds (#2355).
  let pre: AutoUpdateApplyResult;
  try {
    pre = await deps.preflight(candidate);
  } catch (err) {
    pre = { code: 1, rolledBack: false, error: errorMessage(err) };
  }
  if (pre.code !== 0) {
    const error = `preflight failed: ${pre.error ?? `exit ${pre.code}`}`;
    finish({ outcome: 'skipped', error });
    deps.log(`update: ${candidate} ${error}; not draining`);
    return 'preflight-failed';
  }

  let stopFiles: string[] = [];
  try {
    stopFiles = await deps.writeStops();
    safeWrite({
      ...(readUpdateState(deps.stateFile) ?? state),
      draining: { since: iso(), target: candidate, stopFiles },
    });
    deps.log(`update: draining for ${candidate} (STOP set in ${stopFiles.length} repo(s))`);
    const deadline = deps.now() + drainTimeoutMinutes * 60_000;
    const pollMs = deps.drainPollMs ?? 30_000;
    for (;;) {
      const active = await deps.activeRuns();
      if (active.length === 0) break;
      if (deps.now() >= deadline) {
        const error = `drain timed out after ${drainTimeoutMinutes} min (active: ${active.join(', ')})`;
        finish({ outcome: 'skipped', error });
        deps.log(`update: ${error}; will retry next interval`);
        return 'drain-timeout';
      }
      await deps.sleep(pollMs);
    }

    let res: AutoUpdateApplyResult;
    try {
      res = await deps.apply(candidate);
    } catch (err) {
      res = { code: 1, rolledBack: false, error: errorMessage(err) };
    }
    if (res.code === 0) {
      finish({ outcome: 'updated' }, { available: null });
      deps.log(`update: updated to ${candidate}; restarting`);
      return 'updated';
    }
    if (res.code === AUTO_UPDATE_BUSY_EXIT_CODE) {
      const error = 'apply refused: a run is active';
      finish({ outcome: 'skipped', error });
      deps.log(`update: ${error}; will retry next interval`);
      return 'busy';
    }
    const outcome = res.rolledBack ? 'rolled-back' : 'failed';
    const error = res.error ?? `exit ${res.code}`;
    finish({ outcome, error });
    deps.log(`update: ${candidate} ${outcome} (${error})`);
    return 'failed';
  } finally {
    try {
      await deps.clearStops(stopFiles);
    } catch (err) {
      deps.log(`update: could not clear STOP files: ${errorMessage(err)}`);
    }
  }
}

/** Sleeps the check interval, runs a cycle, and exits 75 after a successful update. */
export async function runAutoUpdateLoop(config: AutoUpdateConfig, deps: AutoUpdateDeps): Promise<void> {
  if (config.autoUpdate.mode === 'manual') return;
  while (!deps.stopped?.()) {
    await deps.sleep(config.autoUpdate.checkIntervalMinutes * 60_000);
    if (deps.stopped?.()) return;
    try {
      const outcome = await runAutoUpdateCycle(config, deps);
      if (outcome === 'updated') {
        await deps.exit(AUTO_UPDATE_RESTART_EXIT_CODE);
        return;
      }
    } catch (err) {
      deps.log(`update cycle failed: ${errorMessage(err)}`);
    }
  }
}

/** Removes STOP files a previous (crashed) drain left behind; returns the paths removed. */
export function recoverStaleDrain(previous: UpdateState | null, removeStop: (file: string) => boolean): string[] {
  const removed: string[] = [];
  for (const file of previous?.draining?.stopFiles ?? []) {
    try {
      if (removeStop(file)) removed.push(file);
    } catch {
      // best effort
    }
  }
  return removed;
}

/** Production deps: checks via the injected `check`, applies via `factory self-update --to`, detects activity from the run runtime and run locks. */
export function createAutoUpdateDeps(opts: {
  registryFile: string;
  stateFile: string;
  cliEntrypoint: string;
  /** Registry check; cmdFactoryd passes `checkForUpdate` from self-update.ts (#2354). */
  check: () => Promise<AutoUpdateCheck>;
  runRuntime: Pick<RunRuntime, 'list'>;
  log: (line: string) => void;
  exit: (code: number) => Promise<void> | void;
}): AutoUpdateDeps {
  const exec = defaultExec();
  const attached = async () => listRepos(await loadRegistry(opts.registryFile)).filter((e) => e.state !== 'detached');
  const runSelfUpdate = (args: string[]) => runSelfUpdateCommand(exec, opts.cliEntrypoint, args);
  return {
    stateFile: opts.stateFile,
    check: opts.check,
    apply: (version) => runSelfUpdate(['--to', version, '--no-restart']),
    preflight: (version) => runSelfUpdate(['--to', version, '--dry-run', '--force']),
    async activeRuns() {
      const active = opts.runRuntime
        .list()
        .filter((r) => r.status === 'queued' || r.status === 'running')
        .map((r) => `daemon:${r.repo}#${r.issue}`);
      for (const e of await attached()) {
        const holder = readRunLockHolder(getFactoryPaths(e.path, e.stateRoot).runLock);
        if (holder && defaultIsPidAlive(holder.pid)) active.push(e.slug);
      }
      return active;
    },
    async writeStops() {
      const created: string[] = [];
      for (const e of await attached()) {
        const stop = getFactoryPaths(e.path, e.stateRoot).stop;
        try {
          mkdirSync(dirname(stop), { recursive: true });
          writeFileSync(stop, '', { flag: 'wx' });
          created.push(stop);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            opts.log(`update: could not write STOP for ${e.slug}: ${errorMessage(err)}`);
          }
        }
      }
      return created;
    },
    async clearStops(files) {
      for (const f of files) {
        try {
          unlinkSync(f);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    },
    now: Date.now,
    sleep: (ms) =>
      new Promise((res) => {
        setTimeout(res, ms).unref();
      }),
    log: opts.log,
    exit: opts.exit,
  };
}
