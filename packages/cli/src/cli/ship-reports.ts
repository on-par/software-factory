// packages/cli/src/cli/ship-reports.ts — local-only run-report and benchmark-artifact writers, split from ship-steps.ts (#2788)

import { styleText } from 'node:util';

import type {
  BenchmarkRunFailure,
  CheckSummary,
  EventKind,
  LocalOnlyPolicy,
  WorkRequest,
  getFactoryPaths,
  writeLocalRunReport,
} from '@on-par/factory-core';
import { workKeyFromIssue, writeBenchmarkArtifacts } from '@on-par/factory-core';
import { shipRuntime } from './ship-runtime.js';

export async function maybeWriteLocalRunReport(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  startedAt: string;
  outcome: 'ready' | 'failed' | 'parked' | 'escalated';
  branch?: string;
  worktree?: string;
  specPath?: string;
  route?: string;
  reason?: string;
  writeLocalRunReport?: typeof writeLocalRunReport;
}): Promise<string | undefined> {
  if (process.env.FACTORY_LOCAL_ONLY !== '1') return undefined;
  const report = await (opts.writeLocalRunReport ?? shipRuntime().defaultWriteLocalRunReport())({
    issue: workKeyFromIssue(opts.issueNum),
    eventsFile: opts.paths.events,
    reportsDir: opts.paths.reports,
    startedAt: opts.startedAt,
    outcome: opts.outcome,
    profile: 'local-only',
    branch: opts.branch,
    worktree: opts.worktree,
    specPath: opts.specPath,
    route: opts.route,
    reason: opts.reason,
  });
  console.log(styleText('cyan', `local-only report: ${report.path}`));
  return report.path;
}

export async function maybeWriteBenchmarkArtifacts(opts: {
  issueNum: number;
  paths: ReturnType<typeof getFactoryPaths>;
  ctx?: { localOnly?: LocalOnlyPolicy; artifactsDir?: string; workRequest?: WorkRequest };
  startedAt: string;
  outcome: 'ready' | 'failed' | 'escalated';
  branch?: string;
  specPath?: string;
  route?: string;
  checkSummary?: CheckSummary;
  reworkRounds?: number;
  failure?: BenchmarkRunFailure;
  reportPath?: string;
  diffBase?: string;
  log: (type: EventKind, msg: string) => void;
}): Promise<void> {
  if (!opts.ctx?.localOnly || !opts.ctx.artifactsDir) return;
  try {
    const { manifestPath } = await writeBenchmarkArtifacts({
      issue: workKeyFromIssue(opts.issueNum),
      artifactsDir: opts.ctx.artifactsDir,
      eventsFile: opts.paths.events,
      costsFile: opts.paths.costs,
      startedAt: opts.startedAt,
      outcome: opts.outcome,
      workspace: opts.ctx.localOnly.workspace,
      branch: opts.branch,
      specPath: opts.specPath,
      route: opts.route,
      request: opts.ctx.workRequest,
      checkSummary: opts.checkSummary,
      reworkRounds: opts.reworkRounds,
      failure: opts.failure,
      reportPath: opts.reportPath,
      diffBase: opts.diffBase,
    });
    opts.log('benchmark-artifacts', `manifest written to ${manifestPath}`);
    console.log(styleText('cyan', `benchmark artifacts: ${manifestPath}`));
  } catch (err: any) {
    // Never let artifact emission mask the run outcome.
    opts.log('benchmark-artifacts-failed', `could not write benchmark artifacts: ${err.message}`);
  }
}
