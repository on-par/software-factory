import type { CheckPhaseResult, reworkWorker as reworkWorkerDefault } from '../phases/check.js';
import type { ShipResult } from '../phases/ship.js';
import type { CiSuppressionFinding } from '../types/index.js';
import { workKeyFromIssue } from '../work/work-key.js';
import type { readReworkDiff, readWorktreeHead } from './ci-suppression-guard.js';
import { scanReworkDiff } from './ci-suppression-guard.js';
import type { CiReworkLoopContext } from './ci-rework-loop.js';
import { reworkRouteFor, type BuildRoute, type RunOutcome } from './outcome.js';

type ReworkInput = Parameters<typeof reworkWorkerDefault>[0];

export interface CiReworkRoundPorts {
  ctx: CiReworkLoopContext;
  rework: typeof reworkWorkerDefault;
  readHead: typeof readWorktreeHead;
  readDiff: typeof readReworkDiff;
  builtRoute: BuildRoute;
  builtModel: string;
  reship: (recheck: CheckPhaseResult, reentry: CiReworkReentry) => Promise<ShipResult>;
}

export interface CiReworkReentry {
  prNumber: number;
  previousHeadSha: string | undefined;
}

export interface CiReworkRoundPlan {
  round: number;
  reentry: CiReworkReentry;
  summary: ReworkInput['summary'];
  extraInstructions: string;
}

export type CiReworkRoundOutcome =
  | { kind: 'shipped'; ship: ShipResult }
  | { kind: 'never-ran' }
  | { kind: 'suppressed'; findings: CiSuppressionFinding[] }
  | { kind: 'ended'; outcome: RunOutcome };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const guardError = (match: string): CiSuppressionFinding => ({
  kind: 'path',
  rule: 'guard-error',
  file: '(unknown)',
  match,
});

export async function runCiReworkRound(
  ports: CiReworkRoundPorts,
  plan: CiReworkRoundPlan,
): Promise<CiReworkRoundOutcome> {
  const { ctx } = ports;
  const { request } = ctx;
  const worktree = ctx.ports.workspace.path;
  let before: string;
  try {
    before = await ports.readHead(worktree);
  } catch (err) {
    return { kind: 'suppressed', findings: [guardError(`could not read the worktree HEAD: ${errorMessage(err)}`)] };
  }
  const worked = await ports.rework({
    issue: workKeyFromIssue(request.issue),
    worktree,
    specPath: request.specPath,
    summary: plan.summary,
    constitution: ctx.constitution,
    router: ctx.ports.router,
    log: ctx.ports.events('build'),
    buildTimeoutSeconds: request.timeouts.build,
    sandbox: request.sandboxPolicy,
    appPort: ctx.appPort,
    appBaseUrl: ctx.appBaseUrl,
    onPgid: ctx.onPgid,
    ...reworkRouteFor(ports.builtRoute, ports.builtModel),
    runId: ctx.runId,
    onWorkerResult: ctx.checkOpts.onWorkerResult,
    extraInstructions: plan.extraInstructions,
  });
  if (!worked.modelCompleted) return { kind: 'never-ran' };
  let findings: CiSuppressionFinding[];
  try {
    findings = scanReworkDiff(await ports.readDiff(worktree, before));
  } catch (err) {
    findings = [guardError(`could not read the CI rework diff: ${errorMessage(err)}`)];
  }
  if (findings.length > 0) return { kind: 'suppressed', findings };
  const recheck = await ctx.checkPhase(ctx.checkOpts);
  const ended = await ctx.onRecheck(recheck, plan.round);
  if (ended) return { kind: 'ended', outcome: ended };
  ctx.ports.claimSignal?.throwIfAborted();
  const ship = await ports.reship(recheck, plan.reentry);
  ctx.ports.claimSignal?.throwIfAborted();
  return { kind: 'shipped', ship };
}
