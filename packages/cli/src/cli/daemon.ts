// packages/cli/src/cli/daemon.ts — factory daemon start|stop|status|logs: launchctl
// wrappers around the foreground factoryd (#1179, epic #764).

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
import { dirname, join } from 'node:path';

import { defaultRegistryPath, listRepos, loadRegistry } from '@on-par/factory-core/internal';

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
 *  attached repos from the registry. Exit code 0 when running, 1 when not. */
export async function cmdDaemonStatus(deps: DaemonCtlDeps = {}): Promise<void> {
  const d = resolveDeps(deps);
  requireDarwin(d.platform);
  const { plistPath, logPath } = factorydFiles(d.home);

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
