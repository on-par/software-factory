// packages/cli/src/cli/self-update-apply.ts — factory self-update --to <version> (#2355)
import { execFile } from 'node:child_process';
import { delimiter, join } from 'node:path';

import {
  daemonRuntimePaths,
  defaultRegistryPath,
  listRepos,
  loadRegistry,
  readRunLockHolder,
} from '@on-par/factory-core/internal';
import { defaultIsPidAlive, getFactoryPaths } from '@on-par/factory-core';

import { detectInstall, type InstallKind } from './daemon.js';
import { EXIT_UP_TO_DATE, PACKAGE_NAME, parseSemver, type SelfUpdateDeps } from './self-update.js';
import { recordUpdateResult, updateStatePath, type UpdateOutcome } from './update-state.js';

// ---------------------------------------------------------------------------
// factory self-update --to <version> (#2355)

/** `self-update --to` exit codes. 0 ok / dry-run ok, 1 failed (rolled back or not), 2 refused (bad version or not npm-global), 3 busy. */
export const EXIT_APPLY_FAILED = 1;
export const EXIT_APPLY_REFUSED = 2;
export const EXIT_APPLY_BUSY = 3;

export type ApplyOutcome = 'updated' | 'up-to-date' | 'dry-run' | 'rolled-back' | 'failed' | 'refused' | 'busy';

export interface ApplyStep {
  step: 'preflight' | 'install' | 'verify' | 'doctor' | 'rollback' | 'rollback-verify' | 'restart';
  ok: boolean;
  code: number;
  detail: string | null;
}

export interface SelfUpdateApplyResult {
  outcome: ApplyOutcome;
  from: string;
  to: string;
  installKind: InstallKind;
  prefix: string;
  dryRun: boolean;
  rolledBack: boolean;
  /** 'factoryd' when the caller (factoryd) restarts itself; 'restarted' / 'not-running' / 'failed' for a manual run; null when nothing was installed. */
  restart: 'factoryd' | 'restarted' | 'not-running' | 'failed' | null;
  steps: ApplyStep[];
  error: string | null;
}

export type ApplyExec = NonNullable<SelfUpdateDeps['exec']>;
export type SelfUpdateApplyDeps = SelfUpdateDeps;

/** Slugs of attached repos whose run lock is held by a live pid. */
export async function attachedRunLocks(registryFile: string = defaultRegistryPath()): Promise<string[]> {
  const active: string[] = [];
  for (const e of listRepos(await loadRegistry(registryFile))) {
    if (e.state === 'detached') continue;
    const holder = readRunLockHolder(getFactoryPaths(e.path, e.stateRoot).runLock);
    if (holder && defaultIsPidAlive(holder.pid)) active.push(e.slug);
  }
  return active;
}

export interface SelfUpdateApplyOpts {
  to: string;
  json?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /** false when factoryd invokes us: it restarts itself (exit 75) after a successful apply. */
  restart?: boolean;
}

/** Null when `v` is an exact stable x.y.z (an optional leading v is dropped); otherwise the reason. */
export function stableVersionError(v: string): string | null {
  const p = parseSemver(v);
  if (!p) return `invalid version "${v}" — expected an exact x.y.z release`;
  if (p.prerelease.length > 0) return `"${v}" is a prerelease — self-update --to installs stable releases only`;
  if (/\+/.test(v)) return `invalid version "${v}" — build metadata is not allowed`;
  return null;
}

/** Names of the ❌ (failed) rows in `factory doctor` text output, in order, deduped (#2932). */
export function failingDoctorChecks(output: string): string[] {
  const names: string[] = [];
  for (const raw of output.split('\n')) {
    // eslint-disable-next-line no-control-regex -- strips ANSI color codes
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    const m = /^\s*❌\s+(.+?)\s+-\s/.exec(line) ?? /^\s*❌\s+(.+?)\s*$/.exec(line);
    const name = m?.[1]?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function lastLine(s: string): string | null {
  const l = s
    .trim()
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return l.at(-1) ?? null;
}

/** `env` with `binDir` first on PATH, so `#!/usr/bin/env node` scripts there run under launchd's minimal PATH (#3122). */
export function prependPath(binDir: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const rest = (env.PATH ?? '').split(delimiter).filter((p) => p !== '' && p !== binDir);
  return { ...env, PATH: [binDir, ...rest].join(delimiter) };
}

function defaultApplyExec(binDir: string): ApplyExec {
  return (cmd, args) =>
    new Promise((res) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, env: prependPath(binDir) }, (error, stdout, stderr) => {
        const raw = error ? (error as { code?: unknown }).code : 0;
        res({ code: typeof raw === 'number' ? raw : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
}

/** Installs `to` next to the running Node, verifies it, runs doctor, restarts; rolls back on any failure. Never throws for expected failures. */
export async function applySelfUpdate(
  opts: SelfUpdateApplyOpts,
  deps: SelfUpdateApplyDeps = {},
): Promise<{ code: number; result: SelfUpdateApplyResult }> {
  const install = detectInstall(deps.install);
  const to = opts.to.trim().replace(/^v/, '');
  const prefix = install.prefix;
  const exec = deps.exec ?? defaultApplyExec(join(prefix, 'bin'));
  const npm = join(prefix, 'bin', 'npm');
  const node = join(prefix, 'bin', 'node');
  const cli = join(prefix, 'lib', 'node_modules', '@on-par', 'factory-cli', 'dist', 'cli.js');
  const steps: ApplyStep[] = [];
  const result: SelfUpdateApplyResult = {
    outcome: 'failed',
    from: install.version,
    to,
    installKind: install.kind,
    prefix,
    dryRun: opts.dryRun === true,
    rolledBack: false,
    restart: null,
    steps,
    error: null,
  };
  const done = (code: number, outcome: ApplyOutcome, error: string | null = null) => {
    result.outcome = outcome;
    result.error = error;
    return { code, result };
  };
  const run = async (
    step: ApplyStep['step'],
    cmd: string,
    args: string[],
    detailOf?: (r: { code: number; stdout: string; stderr: string }) => string | null,
  ) => {
    const r = await exec(cmd, args);
    const ok = r.code === 0;
    steps.push({
      step,
      ok,
      code: r.code,
      detail: ok ? null : detailOf ? detailOf(r) : (lastLine(r.stderr) ?? lastLine(r.stdout)),
    });
    return { ...r, ok };
  };
  const installVersion = (v: string, step: 'install' | 'rollback') =>
    run(step, npm, ['i', '-g', '--prefix', prefix, `${PACKAGE_NAME}@${v}`]);
  const verifyVersion = async (v: string, step: 'verify' | 'rollback-verify') => {
    const r = await exec(node, [cli, '--version']);
    const got = r.stdout.trim().replace(/^v/, '');
    const ok = r.code === 0 && got === v;
    steps.push({ step, ok, code: r.code, detail: ok ? null : `expected ${v}, got ${got || `exit ${r.code}`}` });
    return ok;
  };

  const versionError = stableVersionError(opts.to.trim());
  if (versionError !== null) return done(EXIT_APPLY_REFUSED, 'refused', versionError);
  if (install.kind !== 'npm-global') {
    return done(
      EXIT_APPLY_REFUSED,
      'refused',
      `self-update --to needs an npm-global install (this is a ${install.kind} install)`,
    );
  }
  if (opts.force !== true) {
    const active = await (deps.activeRuns ?? (() => attachedRunLocks()))();
    if (active.length > 0)
      return done(EXIT_APPLY_BUSY, 'busy', `a run is active (${active.join(', ')}); pass --force to apply anyway`);
  }
  if (opts.dryRun === true) {
    const r = await run('preflight', npm, ['--version']);
    return r.ok ? done(EXIT_UP_TO_DATE, 'dry-run') : done(EXIT_APPLY_FAILED, 'failed', `npm not runnable at ${npm}`);
  }
  if (to === install.version) return done(EXIT_UP_TO_DATE, 'up-to-date');

  let failure: string | null = null;
  const inst = await installVersion(to, 'install');
  if (!inst.ok) failure = `install of ${to} failed: ${steps.at(-1)?.detail ?? `exit ${inst.code}`}`;
  else if (!(await verifyVersion(to, 'verify'))) failure = `version check failed: ${steps.at(-1)?.detail}`;
  else {
    const doc = await run('doctor', node, [cli, 'doctor'], (r) => {
      const names = failingDoctorChecks(`${r.stdout}\n${r.stderr}`);
      return names.length > 0 ? `failing checks: ${names.join(', ')}` : `exit ${r.code}`;
    });
    if (!doc.ok) failure = `doctor failed on ${to}: ${steps.at(-1)?.detail ?? `exit ${doc.code}`}`;
  }

  if (failure !== null) {
    const rb = await installVersion(install.version, 'rollback');
    const rbOk = rb.ok && (await verifyVersion(install.version, 'rollback-verify'));
    result.rolledBack = rbOk;
    return rbOk
      ? done(EXIT_APPLY_FAILED, 'rolled-back', failure)
      : done(EXIT_APPLY_FAILED, 'failed', `${failure}; rollback to ${install.version} also failed`);
  }

  if (opts.restart === false) {
    result.restart = 'factoryd';
  } else if ((deps.platform ?? process.platform) !== 'darwin') {
    result.restart = 'not-running';
  } else {
    const st = await exec(node, [cli, 'daemon', 'status', '--json']);
    let running = false;
    try {
      running = (JSON.parse(st.stdout) as { running?: unknown }).running === true;
    } catch {
      running = false;
    }
    if (!running) result.restart = 'not-running';
    else {
      const r = await run('restart', node, [cli, 'daemon', 'start']);
      result.restart = r.ok ? 'restarted' : 'failed';
    }
  }
  return done(EXIT_UP_TO_DATE, 'updated');
}

export function formatApplyResult(r: SelfUpdateApplyResult): string {
  switch (r.outcome) {
    case 'updated': {
      let restartText = '';
      if (r.restart === 'restarted') restartText = '; factoryd restarted';
      else if (r.restart === 'failed') {
        const detail = [...r.steps].reverse().find((s) => s.step === 'restart')?.detail;
        restartText = `; factoryd restart failed${detail ? `: ${detail}` : ''} — run \`factory daemon start\``;
      }
      return `factory updated ${r.from} → ${r.to}${restartText}`;
    }
    case 'up-to-date':
      return `factory ${r.from} is already ${r.to}`;
    case 'dry-run':
      return `factory self-update --to ${r.to}: preflight ok (would install with ${r.prefix}/bin/npm)`;
    case 'rolled-back':
      return `factory self-update --to ${r.to} failed and was rolled back to ${r.from}: ${r.error}`;
    case 'busy':
    case 'failed':
    case 'refused':
      return `factory self-update --to ${r.to} ${r.outcome}: ${r.error}`;
  }
}

/** Outcomes a manual run records in update-state lastResult (#2933); nothing was installed for the rest. */
const RECORDED_OUTCOMES: ReadonlySet<ApplyOutcome> = new Set(['updated', 'rolled-back', 'failed']);

export async function cmdSelfUpdateApply(opts: SelfUpdateApplyOpts, deps: SelfUpdateApplyDeps = {}): Promise<number> {
  const { code, result } = await applySelfUpdate(opts, deps);
  // factoryd (--no-restart) records its own result in runAutoUpdateCycle
  if (opts.restart !== false && RECORDED_OUTCOMES.has(result.outcome)) {
    const file = deps.updateStateFile === undefined ? updateStatePath(daemonRuntimePaths().dir) : deps.updateStateFile;
    if (file !== null) {
      try {
        recordUpdateResult(file, {
          at: (deps.now ?? (() => new Date()))().toISOString(),
          version: result.to,
          outcome: result.outcome as UpdateOutcome,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch {
        // best-effort: recording must never change the apply's exit code or output
      }
    }
  }
  (deps.out ?? process.stdout).write(opts.json ? `${JSON.stringify(result)}\n` : `${formatApplyResult(result)}\n`);
  return code;
}
