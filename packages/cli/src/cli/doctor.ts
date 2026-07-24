// packages/cli/src/cli/doctor.ts — `factory doctor` environment preflight

import { resolve } from 'node:path';

import { CLAUDE_CODE_URL, GITHUB_TOKENS_URL } from './first-run.js';

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** One-line fix suggestion; only meaningful when ok=false. */
  fix?: string;
  /** Optional checks never fail the doctor exit code. */
  optional?: boolean;
}

export interface DoctorEnvProbes {
  commandAvailable: (cmd: string) => boolean;
  envPresent: (key: string) => boolean;
  /** Run a command, return trimmed stdout, or null if it fails. */
  tryExec: (cmd: string) => string | null;
  pathExists: (p: string) => boolean;
  distFreshness?: () => { fresh: boolean; detail: string };
}

export function runDoctorChecks(probes: DoctorEnvProbes): DoctorCheck[] {
  const { commandAvailable, envPresent, tryExec, pathExists, distFreshness } = probes;
  const checks: DoctorCheck[] = [];

  const repoRoot = tryExec('git rev-parse --show-toplevel');
  checks.push(
    repoRoot !== null
      ? { name: 'git repository', ok: true, detail: repoRoot }
      : {
          name: 'git repository',
          ok: false,
          detail: 'not inside a git repository',
          fix: 'run factory inside a git repo (`git init` or clone one)',
        },
  );

  checks.push(
    commandAvailable('claude')
      ? { name: 'claude CLI', ok: true, detail: 'found on PATH' }
      : {
          name: 'claude CLI',
          ok: false,
          detail: 'not found on PATH',
          fix: `install Claude Code first: ${CLAUDE_CODE_URL}`,
        },
  );

  if (!commandAvailable('gh')) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh CLI not found on PATH',
      fix: 'install GitHub CLI and run `gh auth login`',
    });
  } else if (tryExec('gh auth status') === null) {
    checks.push({
      name: 'gh auth',
      ok: false,
      detail: 'gh is not authenticated',
      fix: 'install GitHub CLI and run `gh auth login`',
    });
  } else {
    checks.push({ name: 'gh auth', ok: true, detail: 'authenticated' });
  }

  if (envPresent('GITHUB_TOKEN')) {
    checks.push({ name: 'GitHub token', ok: true, detail: 'GITHUB_TOKEN set' });
  } else if (envPresent('GH_TOKEN')) {
    checks.push({ name: 'GitHub token', ok: true, detail: 'GH_TOKEN set' });
  } else {
    const token = tryExec('gh auth token');
    if (token) {
      checks.push({ name: 'GitHub token', ok: true, detail: 'using gh auth token' });
    } else {
      checks.push({
        name: 'GitHub token',
        ok: false,
        detail: 'no GITHUB_TOKEN, GH_TOKEN, or gh auth token',
        fix: `create a token at ${GITHUB_TOKENS_URL} and export it`,
      });
    }
  }

  checks.push(
    commandAvailable('npm')
      ? { name: 'npm', ok: true, detail: 'found on PATH' }
      : {
          name: 'npm',
          ok: false,
          detail: 'not found on PATH',
          fix: 'install Node.js >= 20 (which ships npm): https://nodejs.org',
        },
  );

  if (repoRoot === null) {
    checks.push({
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: 'skipped — not a git repository',
    });
  } else if (tryExec('git status --porcelain') === '') {
    checks.push({ name: 'git worktree clean', ok: true, detail: 'clean' });
  } else {
    checks.push({
      name: 'git worktree clean',
      ok: false,
      optional: true,
      detail: 'uncommitted changes present',
      fix: 'commit or stash changes before running the factory',
    });
  }

  checks.push(
    commandAvailable('codex')
      ? { name: 'codex sandbox', ok: true, optional: true, detail: 'codex CLI found (sandboxed builds available)' }
      : {
          name: 'codex sandbox',
          ok: false,
          optional: true,
          detail: 'codex CLI not found — codex build routes unavailable',
          fix: 'install the codex CLI, or rely on claude routes',
        },
  );

  if (repoRoot === null) {
    checks.push({
      name: '.factory initialized',
      ok: false,
      optional: true,
      detail: 'skipped — not a git repository',
    });
  } else if (pathExists(resolve(repoRoot, '.factory'))) {
    checks.push({ name: '.factory initialized', ok: true, optional: true, detail: '.factory/ present' });
  } else {
    checks.push({
      name: '.factory initialized',
      ok: false,
      optional: true,
      detail: '.factory/ missing',
      fix: 'run `factory init`',
    });
  }

  if (distFreshness) {
    const { fresh, detail } = distFreshness();
    checks.push(
      fresh
        ? { name: 'compiled dist fresh', ok: true, detail }
        : {
            name: 'compiled dist fresh',
            ok: false,
            detail,
            fix: "run 'npm run build' at the monorepo root",
          },
    );
  }

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  const lines = ['== factory doctor =='];
  let passed = 0;
  let failed = 0;
  let warnings = 0;

  for (const check of checks) {
    if (check.ok) {
      passed++;
    } else if (check.optional) {
      warnings++;
    } else {
      failed++;
    }
    const icon = check.ok ? '✅' : '❌';
    lines.push(`  ${icon} ${check.name} — ${check.detail}`);
    if (!check.ok && check.fix) {
      lines.push(`       fix: ${check.fix}`);
    }
  }

  lines.push(`${passed} passed, ${failed} failed, ${warnings} warnings`);
  lines.push('');
  lines.push('Model reachability: factory models --doctor');

  return lines.join('\n');
}

export function doctorFailed(checks: DoctorCheck[]): boolean {
  return checks.some((c) => !c.ok && !c.optional);
}

export interface LeaseHealthRow {
  worktreeId: string;
  branch: string;
  port: number;
  pid: number;
  alive: boolean;
  reason?: 'dead-pid' | 'missing-worktree';
  portSquatted?: boolean;
}

export function leaseChecks(rows: LeaseHealthRow[]): DoctorCheck[] {
  if (rows.length === 0) {
    return [{ name: 'port leases', ok: true, optional: true, detail: 'no active leases' }];
  }

  return rows.map((row) => {
    if (row.alive) {
      return {
        name: `port lease :${row.port}`,
        ok: true,
        optional: true,
        detail: `${row.worktreeId} — port ${row.port}, pid ${row.pid}, live`,
      };
    }

    const squatted = row.portSquatted ? '; port still in use by another process' : '';
    return {
      name: `port lease :${row.port}`,
      ok: false,
      optional: true,
      detail: `${row.worktreeId} — port ${row.port}, pid ${row.pid}, stale (${row.reason})${squatted}`,
      fix: 'run `factory doctor --reconcile` to reclaim stale leases',
    };
  });
}

export interface EventLogIntegrity {
  total: number;
  unparseable: number;
}

export function analyzeEventLog(content: string): EventLogIntegrity {
  const lines = content.split('\n').filter((l) => l.trim() !== '');
  let unparseable = 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      unparseable++;
    }
  }
  return { total: lines.length, unparseable };
}

export function eventLogCheck(integrity: EventLogIntegrity | null): DoctorCheck {
  if (integrity === null) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'no events.ndjson yet' };
  }
  if (integrity.total === 0) {
    return { name: 'event log integrity', ok: true, optional: true, detail: 'events.ndjson is empty' };
  }
  const pct = ((integrity.unparseable / integrity.total) * 100).toFixed(1);
  if (integrity.unparseable === 0) {
    return {
      name: 'event log integrity',
      ok: true,
      optional: true,
      detail: `${integrity.total} lines, 0 unparseable (0.0%)`,
    };
  }
  return {
    name: 'event log integrity',
    ok: false,
    optional: true,
    detail: `${integrity.unparseable} of ${integrity.total} lines unparseable (${pct}%)`,
    fix: 'historical corruption from pre-lock parallel writes; appends are now serialized — metrics over this file carry this error bar',
  };
}

export function formatReconcileReport(
  reaped: Array<{ lease: { worktreeId: string; port: number }; reason: string }>,
): string {
  if (reaped.length === 0) return 'reconcile: no stale leases';

  return reaped
    .map((r) => `reconcile: freed port ${r.lease.port} (worktree ${r.lease.worktreeId}, reason ${r.reason})`)
    .join('\n');
}
