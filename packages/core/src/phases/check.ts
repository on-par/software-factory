// src/phases/check.ts — CHECK phase: independent checkers verify output, rework loop, dispute resolution

import { type CheckerContext, runAllCheckers } from '../checkers/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { leaseEnv } from '../environment/index.js';
import type { ModelRouter } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import type {
  CheckSummary,
  Constitution,
  DisputeResult,
  FailoverReason,
  ReworkCause,
  ReworkInfo,
} from '../types/index.js';

type LogFn = (type: string, msg: string, extra?: { failoverReason?: FailoverReason; rework?: ReworkInfo }) => void;

export interface CheckPhaseResult {
  passed: boolean;
  summary: CheckSummary;
  reworkRounds: number;
  stuck?: boolean;
}

const MAX_REWORK_ROUNDS = 3;

/** Consecutive no-progress rework rounds before the lane is declared stuck. */
const STUCK_THRESHOLD = 2;

/** Provider/CI-level reasons that point away from a factory fault. */
const EXTERNAL_REASONS = new Set<FailoverReason>(['rate_limit', 'usage_cap', 'timeout', 'unavailable']);

/** Deterministic signature of the failing checks: name + volatility-stripped detail. */
function failureSignature(summary: CheckSummary): string {
  return summary.results
    .filter((r) => r.result === 'FAIL')
    .map((r) => `${r.checker}:${normalizeDetail(r.details)}`)
    .sort()
    .join('|');
}

function normalizeDetail(details: string): string {
  return details.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function failingCheckerNames(summary: CheckSummary): string[] {
  return summary.results.filter((r) => r.result === 'FAIL').map((r) => r.checker);
}

function classifyReworkCause(opts: {
  steering?: ConsumedSteering;
  failovers: { reason: FailoverReason }[];
}): ReworkCause {
  if (opts.steering && opts.steering.messages.length > 0) return 'direction-change';
  if (opts.failovers.some((f) => EXTERNAL_REASONS.has(f.reason))) return 'external';
  return 'factory-fault';
}

export async function checkPhase(opts: {
  issue: number;
  worktree: string;
  specPath: string;
  constitution: Constitution | null;
  router: ModelRouter;
  log: LogFn;
  autoRework?: boolean;
  buildTimeoutSeconds?: number;
  checkTimeoutSeconds?: number;
  sandbox?: SandboxPolicy;
  drainSteering?: () => ConsumedSteering;
  appPort?: number;
}): Promise<CheckPhaseResult> {
  const {
    issue,
    worktree,
    specPath,
    constitution,
    router,
    log,
    autoRework = true,
    buildTimeoutSeconds,
    checkTimeoutSeconds,
    sandbox,
    drainSteering,
    appPort,
  } = opts;

  const ctx: CheckerContext = { worktree, specPath };

  log('check', 'Running checkers');

  let summary = await runAllCheckers(ctx, router, constitution, checkTimeoutSeconds);
  let reworkRounds = 0;
  const maxRounds = autoRework ? MAX_REWORK_ROUNDS : 0;

  let stuck = false;
  let noProgressStreak = 0;

  while (summary.failures > 0 && reworkRounds < maxRounds) {
    reworkRounds++;
    const signatureBefore = failureSignature(summary);
    const failingChecks = failingCheckerNames(summary);

    const steering = drainSteering?.();

    const { failovers } = await reworkWorker(
      issue,
      worktree,
      specPath,
      summary,
      constitution,
      router,
      log,
      buildTimeoutSeconds,
      sandbox,
      steering,
      appPort,
    );

    const cause = classifyReworkCause({ steering, failovers });
    log(
      'rework',
      `round ${reworkRounds}/${maxRounds}: ${summary.failures} failing (${failingChecks.join(', ')}) — cause=${cause}`,
      { rework: { round: reworkRounds, failingChecks, cause } },
    );
    if (steering && steering.messages.length > 0) {
      log('steering_applied', describeSteering(steering));
    }

    summary = await runAllCheckers(ctx, router, constitution, checkTimeoutSeconds);
    log('check', `Rework round ${reworkRounds}: ${summary.failures} failures remaining`);

    if (summary.failures > 0 && failureSignature(summary) === signatureBefore) {
      noProgressStreak++;
    } else {
      noProgressStreak = 0;
    }

    if (noProgressStreak >= STUCK_THRESHOLD) {
      stuck = true;
      log(
        'stuck',
        `lane stuck: identical failures (${failingCheckerNames(summary).join(', ')}) across ${STUCK_THRESHOLD} consecutive rework rounds — escalating early`,
        {
          rework: {
            round: reworkRounds,
            failingChecks: failingCheckerNames(summary),
            cause: 'factory-fault',
            stuck: true,
          },
        },
      );
      break;
    }
  }

  for (const s of summary.results.filter((r) => r.result === 'SKIP')) {
    log('check', `SKIPPED: ${s.checker} — ${s.details}`);
  }

  if (summary.failures > 0) {
    log('fail', `${summary.failures} check failures after ${reworkRounds} rework rounds — parking`);
  } else {
    log('check', summary.skips > 0 ? `All checkers passed (${summary.skips} skipped)` : 'All checkers passed');
  }

  return { passed: summary.failures === 0, summary, reworkRounds, stuck };
}

async function reworkWorker(
  issue: number,
  worktree: string,
  specPath: string,
  summary: CheckSummary,
  constitution: Constitution | null,
  router: ModelRouter,
  log: LogFn,
  timeoutSeconds?: number,
  sandbox?: SandboxPolicy,
  steering?: ConsumedSteering,
  appPort?: number,
): Promise<{ failovers: { model: string; reason: FailoverReason; detail?: string }[] }> {
  const constitutionCtx = buildConstitutionContext(constitution);
  const failures = summary.results.filter((r) => r.result === 'FAIL');
  const failureDetails = failures.map((f) => `### ${f.checker}\n${f.details}`).join('\n\n');

  let prompt = `You are a WORKER agent in the rework loop of a software factory.
Your previous work on issue #${issue} failed independent verification. Fix the
specific failures listed below.

WORKTREE: ${worktree} (you are here)
SPEC: ${specPath}

${constitutionCtx}

## Check Failures (from independent verification agents)
${failureDetails}

## Instructions
1. Read each failure carefully. The checker verified your work independently —
   do not argue with the checkers. Fix the issues.
2. Re-read the spec and constitution if needed to understand the standard.
3. Fix each failure in the worktree.
4. Re-run any tests/builds to confirm your fixes work.
5. Commit your fixes with a clear message.

Do not push, do not open a PR. Just fix and commit. The checker will re-verify.`;

  prompt = applySteering(prompt, steering);

  const reworkResult = await router
    .run('build_claude', prompt, {
      worktree,
      timeoutSeconds: timeoutSeconds ?? 7200,
      sandbox,
      onSandboxEvent: (type, detail) => log(type, detail),
      onLog: (msg) => log('router', msg),
      ...(appPort ? { env: leaseEnv(appPort) } : {}),
    })
    .catch(() => null);

  const failovers = reworkResult ? failoversFrom(reworkResult.attempts) : [];
  for (const f of failovers) {
    log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }

  return { failovers };
}

export async function disputeResolution(opts: {
  issue: number;
  worktree: string;
  specPath: string;
  checkerName: string;
  checkerDetails: string;
  constitution: Constitution | null;
  router: ModelRouter;
  timeoutSeconds?: number;
  log?: LogFn;
}): Promise<DisputeResult> {
  const { issue, worktree, specPath, checkerName, checkerDetails, constitution, router, timeoutSeconds, log } = opts;
  const constitutionCtx = buildConstitutionContext(constitution);

  const prompt = `You are the BOSS in a software factory. A worker agent is disputing
a checker agent's failure. You must arbitrate by re-reading the constitution —
standards outrank both the worker and the checker.

ISSUE: #${issue}
WORKTREE: ${worktree}
SPEC: ${specPath}

${constitutionCtx}

## Checker Finding
Checker: ${checkerName}
Details: ${checkerDetails}

## Your Job
1. Read the constitution's standards and dispute rules carefully.
2. Inspect the actual work in the worktree.
3. Decide: Is the checker correct (upheld) or is the worker correct (overruled)?
4. Return JSON (and ONLY the JSON):
{"verdict":"upheld" or "overruled","reasoning":"<one paragraph citing the standard>","action":"<what happens next>"}`;

  const result = await router
    .run('dispute_resolution', prompt, {
      worktree,
      timeoutSeconds: timeoutSeconds ?? 1800,
    })
    .catch(() => null);

  if (!result) {
    return { verdict: 'upheld', reasoning: 'dispute agent failed', action: 'worker must fix' };
  }

  for (const f of failoversFrom(result.attempts)) {
    log?.('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }

  const match = result.output.match(/"verdict"\s*:\s*"(upheld|overruled)"/);
  const verdict = (match?.[1] as 'upheld' | 'overruled') ?? 'upheld';
  const reasoningMatch = result.output.match(/"reasoning"\s*:\s*"([^"]*)"/);
  const actionMatch = result.output.match(/"action"\s*:\s*"([^"]*)"/);

  return {
    verdict,
    reasoning: reasoningMatch?.[1] ?? '',
    action: actionMatch?.[1] ?? '',
  };
}
