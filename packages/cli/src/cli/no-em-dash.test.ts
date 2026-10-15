import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  claudeKeychainCheck,
  type DoctorCheck,
  type DoctorEnvProbes,
  formatDoctorChecks,
  harnessInstallChecks,
  NOT_IN_REPO_SKIP_DETAIL,
  runDoctorChecks,
  sandboxAuthSkipDetail,
  sandboxClaudeAuthChecks,
} from './doctor.js';
import { declaredHarnessChecks } from './doctor-config.js';
import { gitAuthCheck } from './doctor-git-auth.js';
import {
  eventLogCheck,
  formatClaimReconcileReport,
  formatContainerReconcileReport,
  formatMicroVmReconcileReport,
  formatWorktreeReconcileReport,
  leaseChecks,
  unmergedGreenPrChecks,
} from './doctor-health.js';
import { triageQueueHeader } from './index.js';
import { sweepHeartbeatCheck } from './sweep-heartbeat.js';
import { stopSentinelCheck } from './stop-sentinel.js';

const EM_DASH = '—';

function missingProbes(overrides: Partial<DoctorEnvProbes> = {}): DoctorEnvProbes {
  return {
    commandAvailable: () => false,
    envPresent: () => false,
    tryExec: () => null,
    pathExists: () => false,
    ...overrides,
  };
}

function doctorChecks(): DoctorCheck[] {
  const missing = missingProbes();
  const inRepo = missingProbes({
    commandAvailable: (cmd) => cmd === 'git',
    tryExec: (cmd) => (cmd.includes('git rev-parse') ? '/repo' : null),
  });
  const hostOkSandboxFailed = {
    host: 'ok',
    sandboxed: 'failed',
    hostDetail: 'ok',
    sandboxDetail: 'sandbox failed',
  } as const;
  return [
    { name: 'not in repo', ok: true, optional: true, detail: NOT_IN_REPO_SKIP_DETAIL },
    {
      name: 'skip no runtime',
      ok: true,
      optional: true,
      detail: sandboxAuthSkipDetail({ runtimeAvailable: false, hostOk: true, inRepo: true }) ?? '',
    },
    {
      name: 'skip host not ok',
      ok: true,
      optional: true,
      detail: sandboxAuthSkipDetail({ runtimeAvailable: true, hostOk: false, inRepo: true }) ?? '',
    },
    ...runDoctorChecks(missing),
    ...runDoctorChecks(inRepo),
    ...harnessInstallChecks(
      () => false,
      () => null,
    ),
    gitAuthCheck(null, () => null),
    gitAuthCheck('/repo', () => null),
    ...sandboxClaudeAuthChecks(hostOkSandboxFailed),
    ...sandboxClaudeAuthChecks({
      host: 'failed',
      sandboxed: 'failed',
      hostDetail: 'no',
      sandboxDetail: 'sandbox failed',
    }),
    ...sandboxClaudeAuthChecks({ host: 'skipped', sandboxed: 'skipped', hostDetail: 'x', sandboxDetail: 'y' }),
    claudeKeychainCheck({ status: 'unreadable', inTmux: true }),
    claudeKeychainCheck({ status: 'unreadable', inTmux: false, configDir: '/tmp/c', service: 'svc' }),
    claudeKeychainCheck({ status: 'readable' }),
    ...leaseChecks([
      { worktreeId: 'wt-1', branch: 'b1', port: 3101, pid: 1, alive: true },
      { worktreeId: 'wt-2', branch: 'b2', port: 3102, pid: 2, alive: false, reason: 'dead-pid', portSquatted: true },
    ]),
    eventLogCheck({ total: 10, unparseable: 3 }),
    ...unmergedGreenPrChecks({ status: 'failed', detail: 'boom' }),
    ...unmergedGreenPrChecks({
      status: 'ok',
      rows: [
        { number: 5, branch: 'factory/5', issue: 5, ageHours: 3 },
        { number: 6, branch: 'factory/x', issue: null, ageHours: 4 },
      ],
    }),
    ...declaredHarnessChecks([
      { harness: 'claude', probe: 'claude --version', status: 'unavailable', detail: 'missing' },
      { harness: 'codex', status: 'unavailable', detail: '' },
    ]),
    sweepHeartbeatCheck({ status: 'missing', file: 'hb' }) as DoctorCheck,
    sweepHeartbeatCheck({ status: 'stale', file: 'hb', ageSeconds: 99, thresholdSeconds: 10 }) as DoctorCheck,
    stopSentinelCheck({ present: false }),
    stopSentinelCheck({ present: true, ageMs: 5000, writtenAt: '2026-01-01T00:00:00Z' }),
  ];
}

describe('no em dashes in user-facing CLI output (#2456)', () => {
  it('renders the triage header for the default-code constitution without U+2014', () => {
    const header = triageQueueHeader('gpt-x', 'default-code');
    expect(header).not.toContain(EM_DASH);
    expect(header).toContain('constitution default-code');
  });

  it('renders a full doctor report with no U+2014 on any line', () => {
    const checks = doctorChecks();
    const reaped = [
      { name: 'c1', removed: false, detail: 'busy' },
      { name: 'c2', removed: true, detail: '' },
    ];
    const out = [
      formatDoctorChecks(checks, { inRepo: false }),
      formatDoctorChecks(checks, { inRepo: true }),
      formatContainerReconcileReport(reaped),
      formatMicroVmReconcileReport(reaped),
      formatWorktreeReconcileReport([{ path: '/w', branch: 'b', reason: 'merged', branchDeleted: true }]),
      formatClaimReconcileReport([
        { issue: 1, expiresAt: 5, released: false, detail: 'nope' },
        { issue: 2, expiresAt: 6, released: false },
      ]),
    ].join('\n');
    expect(out).toContain(' - ');
    for (const line of out.split('\n')) expect(line, line).not.toContain(EM_DASH);
  });
});

/** Lines of `source` (outside comments) that contain U+2014, as `label:line: text`. */
function findEmDashLines(source: string, label: string, lineOffset = 0): string[] {
  const hits: string[] = [];
  let inBlock = false;
  source.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      return;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (line.includes(EM_DASH)) hits.push(`${label}:${lineOffset + i + 1}: ${trimmed}`);
  });
  return hits;
}

/** A function's source from its declaration to the first closing `}` at column 0, plus its line offset. */
function functionSource(source: string, name: string): { text: string; offset: number } {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`function ${name}\\(`).test(l));
  if (start === -1) throw new Error(`function ${name} not found; update the em dash guard`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return { text: lines.slice(start, end + 1).join('\n'), offset: start };
}

const read = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf-8');

describe('em dash guard', () => {
  it('doctor and triage sources contain no U+2014 outside comments', () => {
    const hits: string[] = [];
    for (const file of [
      './doctor.ts',
      './doctor-health.ts',
      './doctor-config.ts',
      './sweep-heartbeat.ts',
      './stop-sentinel.ts',
    ]) {
      hits.push(...findEmDashLines(read(file), file));
    }
    const index = read('./index.ts');
    for (const name of ['cmdTriage', 'cmdTriageAccept', 'triageQueueHeader']) {
      const fn = functionSource(index, name);
      hits.push(...findEmDashLines(fn.text, `./index.ts(${name})`, fn.offset));
    }
    expect(hits, `user-facing strings with an em dash (U+2014):\n${hits.join('\n')}`).toEqual([]);
  });

  it('flags a string literal with U+2014 and names it, ignoring comments', () => {
    const source = ['// a — comment', '/** a — block', ' * more — text */', "const s = 'bad — string';"].join('\n');
    const hits = findEmDashLines(source, 'synthetic.ts');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('bad — string');
    expect(hits[0]).toContain(':4:');
  });
});
