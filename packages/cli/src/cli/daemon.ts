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
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { createLogger, getFactoryPaths } from '@on-par/factory-core';
import {
  daemonRuntimePaths,
  DEFAULT_FACTORYD_PORT,
  defaultRegistryPath,
  listRepos,
  loadRegistry,
  parseRemoteSlug,
  readOriginUrl,
  type RepoState,
} from '@on-par/factory-core/internal';

import { buildDaemonRepoJson } from './daemon-repo-json.js';

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
  /** HTTP client for the factoryd routes (attach/detach). Default globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Daemon state dir holding daemon.port. Default dirname(registryFile). */
  stateDir?: string;
  /** Default process.cwd(). */
  cwd?: string;
  /** Origin remote URL of a checkout. Default core's readOriginUrl. */
  readOrigin?: (dir: string) => Promise<string | null>;
  /** Default process.stderr. */
  err?: { write(s: string): unknown };
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

/** Resolved options for the foreground `factory daemon run` process. */
export interface FactorydConfig {
  /** Registry file served (default ~/.factory/registry.json). */
  registryFile: string;
  /** Port to bind on 127.0.0.1 (default DEFAULT_FACTORYD_PORT). */
  port: number;
  /** Opt-in auto-update (#2128). Off unless --auto-update was passed; nothing acts on it yet. */
  autoUpdate: boolean;
}

/** Resolves `factory daemon run` options into a FactorydConfig. Throws
 *  DaemonCtlError (code 2) on an invalid --port. */
export function resolveFactorydConfig(opts: {
  port?: string;
  registry?: string;
  autoUpdate?: boolean;
}): FactorydConfig {
  const port = opts.port === undefined ? DEFAULT_FACTORYD_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DaemonCtlError(`invalid --port "${opts.port}" — expected an integer 0-65535`, 2);
  }
  return { registryFile: opts.registry ?? defaultRegistryPath(), port, autoUpdate: opts.autoUpdate === true };
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
  fetch: typeof globalThis.fetch;
  stateDir: string;
  cwd: string;
  readOrigin: (dir: string) => Promise<string | null>;
  err: { write(s: string): unknown };
}

function resolveDeps(deps: DaemonCtlDeps): ResolvedDeps {
  const registryFile = deps.registryFile ?? defaultRegistryPath();
  return {
    exec: deps.exec ?? defaultExec(),
    home: deps.home ?? homedir(),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    platform: deps.platform ?? process.platform,
    out: deps.out ?? process.stdout,
    nodePath: deps.nodePath ?? process.execPath,
    cliScriptPath: deps.cliScriptPath ?? realpathSync(process.argv[1] ?? ''),
    registryFile,
    pollMs: deps.pollMs ?? 250,
    fetch: deps.fetch ?? globalThis.fetch,
    stateDir: deps.stateDir ?? dirname(registryFile),
    cwd: deps.cwd ?? process.cwd(),
    readOrigin: deps.readOrigin ?? readOriginUrl,
    err: deps.err ?? process.stderr,
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

/** Port for the factoryd HTTP routes: --port, else the `port` factoryd recorded in
 *  daemon.port, else DEFAULT_FACTORYD_PORT. Throws DaemonCtlError (code 2) on an invalid flag. */
export function resolveFactorydPort(flag: string | undefined, portFile: string): number {
  if (flag !== undefined) {
    const port = Number(flag);
    if (flag.trim() === '' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw new DaemonCtlError(`invalid --port "${flag}" — expected an integer 0-65535`, 2);
    }
    return port;
  }
  try {
    const port = (JSON.parse(readFileSync(portFile, 'utf-8')) as { port?: unknown }).port;
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  } catch {
    // missing or unparsable — fall through to the default
  }
  return DEFAULT_FACTORYD_PORT;
}

type FactorydReply = { kind: 'unreachable' } | { kind: 'response'; status: number; json: unknown };

async function callFactoryd(
  d: ResolvedDeps,
  method: 'POST' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<FactorydReply> {
  try {
    const res = await d.fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(5000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { kind: 'response', status: res.status, json };
  } catch {
    return { kind: 'unreachable' };
  }
}

function failReason(status: number, json: unknown): { reason: string; detail: string } {
  const obj = json !== null && typeof json === 'object' ? (json as { reason?: unknown; error?: unknown }) : {};
  return {
    reason: typeof obj.reason === 'string' && obj.reason !== '' ? obj.reason : 'unknown-failure',
    detail: typeof obj.error === 'string' && obj.error !== '' ? obj.error : `HTTP ${status}`,
  };
}

/** Appends one pipeline event to the repo's events log. Best-effort: only when its
 *  state root exists, quiet on stdout, and never throws (warns on stderr). */
function emitRepoEvent(d: ResolvedDeps, kind: 'repo-attached' | 'repo-detached', json: unknown, msg: string): void {
  try {
    const entry = (json as { repo?: { path?: unknown; stateRoot?: unknown } } | null)?.repo;
    if (!entry || typeof entry.path !== 'string') return;
    const paths = getFactoryPaths(entry.path, typeof entry.stateRoot === 'string' ? entry.stateRoot : undefined);
    if (!existsSync(paths.root)) return;
    mkdirSync(paths.state, { recursive: true });
    createLogger(paths.events, { issue: '-' }, { out: { write: () => true } }).info(kind, msg);
  } catch (err) {
    d.err.write(`factoryd: could not record ${kind} event: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

function finishRepoCommand(
  d: ResolvedDeps,
  json: boolean | undefined,
  payload: { action: 'attach' | 'detach'; repo: string | null; ok: boolean; reason?: string },
  text: string,
  failure?: { detail: string; code: number },
): void {
  if (json) d.out.write(`${JSON.stringify(buildDaemonRepoJson(payload))}\n`);
  else if (!failure) d.out.write(text);
  if (failure) throw new DaemonCtlError(failure.detail, failure.code);
}

/** `factory daemon attach`: POST /repos for the checkout at --path (default cwd). */
export async function cmdDaemonAttach(
  opts: { path?: string; port?: string; json?: boolean },
  deps: DaemonCtlDeps = {},
): Promise<void> {
  const d = resolveDeps(deps);
  const dir = resolve(d.cwd, opts.path ?? '.');
  const port = resolveFactorydPort(opts.port, daemonRuntimePaths(d.stateDir).portFile);
  const origin = await d.readOrigin(dir);
  const slug = origin ? parseRemoteSlug(origin) : null;
  if (!slug) {
    finishRepoCommand(d, opts.json, { action: 'attach', repo: null, ok: false, reason: 'not-a-git-checkout' }, '', {
      detail: `${dir} has no origin remote that parses to owner/name`,
      code: 1,
    });
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  const reply = await callFactoryd(d, 'POST', `${base}/repos`, { repo: slug, path: dir });
  if (reply.kind === 'unreachable') {
    finishRepoCommand(d, opts.json, { action: 'attach', repo: slug, ok: false, reason: 'daemon-unreachable' }, '', {
      detail: `factoryd is not reachable at ${base} — start it with \`factory daemon start\` or \`factory daemon run\``,
      code: 1,
    });
    return;
  }
  if (reply.status < 200 || reply.status >= 300) {
    const { reason, detail } = failReason(reply.status, reply.json);
    finishRepoCommand(d, opts.json, { action: 'attach', repo: slug, ok: false, reason }, '', { detail, code: 1 });
    return;
  }
  emitRepoEvent(d, 'repo-attached', reply.json, `factory daemon attach: ${slug} attached (${dir})`);
  finishRepoCommand(d, opts.json, { action: 'attach', repo: slug, ok: true }, `factoryd: attached ${slug} (${dir})\n`);
}

/** `factory daemon detach <owner/name>`: DELETE /repos/<owner>/<name>. */
export async function cmdDaemonDetach(
  slug: string,
  opts: { port?: string; json?: boolean },
  deps: DaemonCtlDeps = {},
): Promise<void> {
  const d = resolveDeps(deps);
  const port = resolveFactorydPort(opts.port, daemonRuntimePaths(d.stateDir).portFile);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
    finishRepoCommand(d, opts.json, { action: 'detach', repo: slug, ok: false, reason: 'invalid-request' }, '', {
      detail: `invalid repo "${slug}" — expected owner/name`,
      code: 2,
    });
    return;
  }
  const [owner = '', name = ''] = slug.split('/');
  const base = `http://127.0.0.1:${port}`;
  const reply = await callFactoryd(
    d,
    'DELETE',
    `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  if (reply.kind === 'unreachable') {
    finishRepoCommand(d, opts.json, { action: 'detach', repo: slug, ok: false, reason: 'daemon-unreachable' }, '', {
      detail: `factoryd is not reachable at ${base} — start it with \`factory daemon start\` or \`factory daemon run\``,
      code: 1,
    });
    return;
  }
  if (reply.status !== 200 && reply.status !== 202) {
    const { reason, detail } = failReason(reply.status, reply.json);
    finishRepoCommand(d, opts.json, { action: 'detach', repo: slug, ok: false, reason }, '', { detail, code: 1 });
    return;
  }
  const draining = reply.status === 202;
  emitRepoEvent(d, 'repo-detached', reply.json, `factory daemon detach: ${slug} ${draining ? 'draining' : 'detached'}`);
  finishRepoCommand(
    d,
    opts.json,
    { action: 'detach', repo: slug, ok: true },
    draining ? `factoryd: detaching ${slug} (draining in-flight lanes)\n` : `factoryd: detached ${slug}\n`,
  );
}
