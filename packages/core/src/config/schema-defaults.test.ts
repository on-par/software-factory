import { defaultFactoryConfig, defaultSchemaFields } from '@on-par/factory-config';
import { describe, expect, it } from 'vitest';
import { FactoryConfigSchema } from './index.js';

const base = {
  version: 1,
  paths: { constitutions: 'c/', checkers: 'k/', plans: 'p/', logs: 'l/', events: 'e.ndjson' },
  timeouts: { plan_seconds: 1, build_seconds: 2, check_seconds: 3, merge_poll_seconds: 4 },
  merge: { auto: false, comment: 'm' },
  worktree: { parent: 'w', comment: 'w' },
  byok: { enabled: false, comment: 'b' },
  notifications: {},
  cost_tracking: { enabled: true, log_file: 'x', comment: 'c' },
};

const parse = (extra: Record<string, unknown> = {}) => FactoryConfigSchema.parse({ ...base, ...extra });

describe('FactoryConfigSchema defaults', () => {
  it("fills every omitted section with today's effective defaults", () => {
    const c = parse();
    expect(c.paths.constitution).toBe('.factory/constitution.md');
    expect([c.timeouts.approval_seconds, c.timeouts.tests_seconds, c.timeouts.compile_seconds]).toStrictEqual([
      1800, 300, 120,
    ]);
    expect([c.merge.admin, c.merge.maxConflictRounds, c.merge.maxLandDeferrals]).toStrictEqual([false, 2, 3]);
    expect([c.worktree.gcTtlDays, c.worktree.autoGcOnRun, c.worktree.retainMax]).toStrictEqual([7, true, 8]);
    expect(c.ci).toStrictEqual({
      skip: false,
      comment: 'Set FACTORY_SKIP_CI=1 to skip waiting for GitHub Actions CI before merging',
    });
    expect(c.sweep).toStrictEqual({ loopIntervalSeconds: 300, staleThresholdMultiplier: 2 });
    expect(c.plan_approval).toStrictEqual({ enabled: false });
    expect(c.design).toStrictEqual({ blockUnresolvedRegressions: false });
    expect(c.readiness).toStrictEqual({ updateIssueBody: true });
    expect(c.build).toStrictEqual({ publishFromBuild: false, contextCeiling: { 'codex-cli': 120000 } });
    expect(c.kpis).toStrictEqual({ defectWindowDays: 14 });
    expect(c.discovery).toStrictEqual({ enabled: true, schedule: 'weekly', maxCandidates: 5 });
    expect(c.filing).toStrictEqual({
      enabled: true,
      excludeReasons: ['rate_limit', 'usage_cap', 'timeout', 'verify_failed'],
      repeatThreshold: 3,
      maxPerRun: 5,
      maxPerDay: 20,
      selfFixLabel: 'no-auto-merge',
      bugLabels: ['bug'],
      sensitivePaths: ['packages/core/', 'packages/config/', 'packages/cli/', 'scripts/', '.github/'],
    });
    expect(c.ingest).toStrictEqual({ enabled: false, label: 'ready', lane: 'auto', maxPerCycle: 20 });
    expect(c.intake).toStrictEqual({ enforce: 'warn' });
    expect(c.environment).toStrictEqual({
      ports: { enabled: true, range: [3100, 3999] },
      processGroups: { graceMs: 5000 },
      proxy: { enabled: false, port: 80, domain: 'factory.localhost' },
    });
    expect(c.host).toStrictEqual({ maxBuilds: 2, maxAgentJobs: 1, loadGuard: { enabled: true, retrySeconds: 60 } });
    expect(c.auto_failover).toStrictEqual({ enabled: true, cooldown_minutes: 30, fallback_model: 'claude-sonnet-5' });
    expect(c.queue).toStrictEqual({
      claim_settle_ms: 3000,
      max_review_rework_runs: 2,
      maxClockSkewMs: 60000,
      discovery_interval_ms: 60000,
      stackOnOpenPrerequisite: true,
    });
    expect(c.adr).toStrictEqual({ mandate: false });
    expect(c.workspace).toStrictEqual({ backend: 'host' });
    expect(c.tracker).toStrictEqual({ kind: 'github' });
  });

  it('reads every schema default from @on-par/factory-config', () => {
    const c = parse();
    const d = defaultFactoryConfig;
    expect(c.paths.constitution).toBe(d.paths.constitution);
    expect(c.timeouts.approval_seconds).toBe(d.timeouts.approval_seconds);
    expect(c.timeouts.tests_seconds).toBe(d.timeouts.tests_seconds);
    expect(c.timeouts.compile_seconds).toBe(d.timeouts.compile_seconds);
    expect(c.merge.admin).toBe(defaultSchemaFields.mergeAdmin);
    expect(c.merge.maxConflictRounds).toBe(d.merge.maxConflictRounds);
    expect(c.merge.maxLandDeferrals).toBe(d.merge.maxLandDeferrals);
    expect(c.worktree.retainMax).toBe(d.worktree.retainMax);
    expect(c.ci.skip).toBe(d.ci.skip);
    expect(c.ci.comment).toBe(defaultSchemaFields.ciComment);
    expect(c.build.contextCeiling).toStrictEqual(d.build.contextCeiling);
    expect(c.filing.excludeReasons).toStrictEqual(d.filing.excludeReasons);
    expect(c.environment.ports.range).toStrictEqual(d.environment.ports.range);
    expect(c.environment.processGroups.graceMs).toBe(defaultSchemaFields.processGroupGraceMs);
    expect(c.host.loadGuard.retrySeconds).toBe(d.host.loadGuard.retrySeconds);
    expect(c.queue.discovery_interval_ms).toBe(d.queue.discovery_interval_ms);
    expect(c.adr.mandate).toBe(defaultSchemaFields.adrMandate);
    expect(c.workspace.backend).toBe(defaultSchemaFields.workspaceBackend);
    expect(c.tracker.kind).toBe(defaultSchemaFields.trackerKind);
  });

  it('fills fields inside an empty section from defaults.ts', () => {
    const c = parse({ discovery: {}, filing: {}, environment: { ports: {} } });
    const d = defaultFactoryConfig;
    expect(c.discovery.maxCandidates).toBe(d.discovery.maxCandidates);
    expect(c.discovery.schedule).toBe(d.discovery.schedule);
    expect(c.filing.maxPerDay).toBe(d.filing.maxPerDay);
    expect(c.filing.sensitivePaths).toStrictEqual(d.filing.sensitivePaths);
    expect(c.environment.ports).toStrictEqual({ enabled: true, range: [3100, 3999] });
  });

  it('does not share array references with defaultFactoryConfig', () => {
    const c = parse();
    expect(c.filing.excludeReasons).not.toBe(defaultFactoryConfig.filing.excludeReasons);
    expect(c.filing.bugLabels).not.toBe(defaultFactoryConfig.filing.bugLabels);
    expect(c.build.contextCeiling).not.toBe(defaultFactoryConfig.build.contextCeiling);
  });
});
