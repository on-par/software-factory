// packages/core/src/queue/test-support/fleet-sim.ts — deterministic multi-claimant simulator for the GitHub label queue (#3150).
//
// N real `createGithubQueue` instances share one in-memory GitHub (FleetStore). Every issue-state call a
// claimant makes parks as a pending step; a scheduler applies exactly one pending step at a time, chosen by
// a caller-supplied chooser. That makes every interleaving enumerable (exploreExhaustive), samplable from a
// seed (exploreSeeded) and replayable from its choice vector (replayFleetSchedule).

import { createSeededRandom, deriveSimSeed } from '../../sim/jitter.js';
import {
  CLAIMED_BY_LABEL_PREFIX,
  claimedByLabel,
  createGithubQueue,
  LANE_LABEL_PREFIX,
  QUEUE_ORDER_LABEL_PREFIX,
  QUEUED_LABEL,
  type GithubQueue,
  type QueueClaim,
  type QueueReleaseOutcome,
} from '../github-queue.js';
import {
  createFleetStore,
  DEFAULT_NOW,
  type FleetGate,
  type FleetIssueSeed,
  type FleetOp,
  type FleetSimClient,
} from './fleet-store.js';

export { createFleetStore };
export type { FleetIssueSeed, FleetOp, FleetSimClient } from './fleet-store.js';

export interface FleetStep {
  index: number;
  actor: string;
  op: FleetOp;
  issue?: number;
  detail: string;
}

export interface FleetViolation {
  invariant:
    | 'single-live-claimant'
    | 'single-order-label'
    | 'unique-lane-position'
    | 'orphaned-claimed-by'
    | 'actor-error'
    | 'max-steps';
  issue?: number;
  step?: number;
  detail: string;
}

export interface FleetActorContext {
  claimantId: string;
  queue: GithubQueue;
  client: FleetSimClient;
}

export type FleetActor = (ctx: FleetActorContext) => Promise<void>;

export interface FleetScenario {
  issues: FleetIssueSeed[];
  claimants: string[];
  /** Defaults to `claimAndReleaseActor(lane)`. */
  actor?: FleetActor;
  /** Defaults to 'main'. */
  lane?: string;
  replicaLag?: number;
  /** Defaults to 500. */
  maxSteps?: number;
  /** Fixed epoch ms handed to every queue as its clock. */
  now?: number;
}

export interface FleetScheduleResult {
  choices: number[];
  enabledCounts: number[];
  seed?: number;
  trace: FleetStep[];
  violations: FleetViolation[];
  labels: Map<number, string[]>;
  /** Set when `visit` cut the schedule short at an already-explored state; its other fields are partial. */
  pruned?: boolean;
}

export interface FleetExploreResult {
  schedules: number;
  truncated: boolean;
  failures: FleetScheduleResult[];
}

const OWNER = 'o';
const REPO = 'r';

/** Pure invariant check over an end state: `labels` per issue, `liveClaims` = claimant ids the harness saw hold each issue. */
export function checkFleetInvariants(
  labels: ReadonlyMap<number, readonly string[]>,
  liveClaims: ReadonlyMap<number, readonly string[]>,
): FleetViolation[] {
  const violations: FleetViolation[] = [];
  const positions = new Map<string, number[]>();
  for (const [issue, have] of labels) {
    const holders = liveClaims.get(issue) ?? [];
    if (holders.length > 1) {
      violations.push({ invariant: 'single-live-claimant', issue, detail: `claimed by ${holders.join(', ')}` });
    }
    const orders = have.filter((l) => l.startsWith(QUEUE_ORDER_LABEL_PREFIX));
    if (orders.length > 1) {
      violations.push({ invariant: 'single-order-label', issue, detail: `order labels ${orders.join(', ')}` });
    }
    if (have.includes(QUEUED_LABEL) && orders.length === 1) {
      for (const lane of have.filter((l) => l.startsWith(LANE_LABEL_PREFIX))) {
        const key = `${lane}|${orders[0]}`;
        const seen = positions.get(key) ?? [];
        seen.push(issue);
        positions.set(key, seen);
      }
    }
    const liveLabels = new Set(holders.map(claimedByLabel));
    for (const label of have.filter((l) => l.startsWith(CLAIMED_BY_LABEL_PREFIX))) {
      if (!liveLabels.has(label)) {
        violations.push({ invariant: 'orphaned-claimed-by', issue, detail: `${label} with no live claim` });
      }
    }
  }
  for (const [key, issues] of positions) {
    if (issues.length > 1) {
      violations.push({
        invariant: 'unique-lane-position',
        issue: issues[1],
        detail: `${key.replace('|', ' ')} shared by #${issues.join(', #')}`,
      });
    }
  }
  return violations;
}

interface PendingStep {
  actorIndex: number;
  actor: string;
  op: FleetOp;
  issue?: number;
  /** Applies the op to the store, resolves the caller, and returns the trace detail. */
  run: () => string;
  fail: (err: unknown) => void;
}

export async function runFleetSchedule(
  scenario: FleetScenario,
  choose: (enabled: number, step: number) => number,
  visit?: (stateKey: string, step: number) => boolean,
): Promise<FleetScheduleResult> {
  const lane = scenario.lane ?? 'main';
  const maxSteps = scenario.maxSteps ?? 500;
  const now = scenario.now ?? DEFAULT_NOW;
  const actor = scenario.actor ?? claimAndReleaseActor(lane);
  const store = createFleetStore(scenario.issues, { replicaLag: scenario.replicaLag ?? 0 });
  const trace: FleetStep[] = [];
  const choices: number[] = [];
  const enabledCounts: number[] = [];
  const violations: FleetViolation[] = [];
  const liveClaims = new Map<number, string[]>();
  const pending: PendingStep[] = [];
  const observed: string[][] = scenario.claimants.map(() => []);
  let pruned = false;
  let running = scenario.claimants.length;
  let stopped = false;
  let wake: (() => void) | null = null;
  const signal = (): void => {
    if (running === 0 && wake) wake();
  };
  const violate = (v: FleetViolation): void => {
    if (!violations.some((x) => x.invariant === v.invariant && x.issue === v.issue)) violations.push(v);
  };

  const wrapQueue = (claimantId: string, queue: GithubQueue): GithubQueue => ({
    ...queue,
    async claimNext(l: string): Promise<QueueClaim | null> {
      const claim = await queue.claimNext(l);
      if (claim) {
        const holders = liveClaims.get(claim.issue) ?? [];
        if (holders.length > 0) {
          violate({
            invariant: 'single-live-claimant',
            issue: claim.issue,
            step: trace.length,
            detail: `${claimantId} claimed while held by ${holders.join(', ')}`,
          });
        }
        liveClaims.set(claim.issue, [...holders, claimantId]);
      }
      return claim;
    },
    async release(issue: number, outcome?: QueueReleaseOutcome): Promise<void> {
      await queue.release(issue, outcome); // held until release returns, so a claim racing the release is seen
      liveClaims.set(
        issue,
        (liveClaims.get(issue) ?? []).filter((id) => id !== claimantId),
      );
    },
  });

  const gateFor =
    (actorIndex: number, name: string): FleetGate =>
    (op, issue, args, exec, fmt) =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error('fleet-sim: schedule stopped'));
          return;
        }
        pending.push({
          actorIndex,
          actor: name,
          op,
          issue,
          run: () => {
            const result = exec();
            resolve(result);
            return [op + (issue === undefined ? '' : ` #${issue}`), args, fmt(result)].filter(Boolean).join(' ');
          },
          fail: reject,
        });
        running -= 1;
        signal();
      });

  const done = scenario.claimants.map((claimantId, i) => {
    const client = store.client(gateFor(i, claimantId));
    const queue = wrapQueue(
      claimantId,
      createGithubQueue({ client, owner: OWNER, repo: REPO, claimantId, now: () => now }),
    );
    return Promise.resolve()
      .then(() => actor({ claimantId, queue, client }))
      .catch((err: unknown) => {
        violate({
          invariant: 'actor-error',
          step: trace.length,
          detail: `${claimantId}: ${err instanceof Error ? err.message : String(err)}`,
        });
      })
      .finally(() => {
        running -= 1;
        signal();
      });
  });

  for (;;) {
    if (running > 0)
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    wake = null;
    if (pending.length === 0) break;
    pending.sort((a, b) => a.actorIndex - b.actorIndex);
    if (trace.length >= maxSteps) {
      violate({ invariant: 'max-steps', step: trace.length, detail: `exceeded ${maxSteps} steps` });
      stopped = true;
      const rest = pending.splice(0);
      running = 1;
      for (const step of rest) step.fail(new Error('fleet-sim: max steps exceeded'));
      running = 0;
      break;
    }
    if (visit) {
      const key = JSON.stringify([
        store.history.slice(-((scenario.replicaLag ?? 0) + 1)),
        [...store.comments],
        observed,
        [...liveClaims],
        violations.map((v) => [v.invariant, v.issue]),
      ]);
      if (!visit(key, trace.length)) {
        pruned = true;
        stopped = true;
        const rest = pending.splice(0);
        running = 1;
        for (const step of rest) step.fail(new Error('fleet-sim: pruned'));
        running = 0;
        break;
      }
    }
    const pick = Math.min(Math.max(choose(pending.length, trace.length), 0), pending.length - 1);
    choices.push(pick);
    enabledCounts.push(pending.length);
    const [step] = pending.splice(pick, 1);
    if (!step) break;
    running = 1;
    try {
      const detail = step.run();
      observed[step.actorIndex]?.push(detail);
      trace.push({ index: trace.length + 1, actor: step.actor, op: step.op, issue: step.issue, detail });
    } catch (err) {
      trace.push({
        index: trace.length + 1,
        actor: step.actor,
        op: step.op,
        issue: step.issue,
        detail: `${step.op} threw`,
      });
      step.fail(err);
    }
  }
  await Promise.all(done);
  if (pruned) return { choices, enabledCounts, trace, violations: [], labels: store.snapshot(), pruned };

  const finalLabels = store.snapshot();
  for (const v of checkFleetInvariants(finalLabels, liveClaims)) violate(v);
  return { choices, enabledCounts, trace, violations, labels: finalLabels };
}

export async function exploreExhaustive(
  scenario: FleetScenario,
  options: { maxSchedules?: number; stopOnFirstViolation?: boolean; dedupeStates?: boolean } = {},
): Promise<FleetExploreResult> {
  const maxSchedules = options.maxSchedules ?? 100_000;
  const stopOnFirstViolation = options.stopOnFirstViolation ?? true;
  const failures: FleetScheduleResult[] = [];
  let prefix: number[] = [];
  const seen = new Set<string>();
  // dedupeStates: cut a schedule at a state (store + each claimant's observations) an earlier schedule already
  // explored, so only distinct states are enumerated rather than every raw interleaving.
  const visit = options.dedupeStates
    ? (key: string, step: number): boolean => {
        // States on the replayed prefix were seen by the schedule that produced it.
        if (step < prefix.length) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }
    : undefined;
  let schedules = 0;
  for (;;) {
    if (schedules >= maxSchedules) return { schedules, truncated: true, failures };
    const fixed = prefix;
    const result = await runFleetSchedule(scenario, (_enabled, step) => fixed[step] ?? 0, visit);
    if (!result.pruned) schedules += 1;
    if (result.violations.length > 0) {
      failures.push(result);
      if (stopOnFirstViolation) return { schedules, truncated: false, failures };
    }
    let i = result.choices.length - 1;
    while (i >= 0 && result.choices[i] === (result.enabledCounts[i] ?? 1) - 1) i -= 1;
    if (i < 0) return { schedules, truncated: false, failures };
    prefix = [...result.choices.slice(0, i), (result.choices[i] ?? 0) + 1];
  }
}

export async function exploreSeeded(
  scenario: FleetScenario,
  options: { seed: number; schedules: number; stopOnFirstViolation?: boolean },
): Promise<FleetExploreResult> {
  const failures: FleetScheduleResult[] = [];
  let schedules = 0;
  for (let i = 0; i < options.schedules; i += 1) {
    const seed = deriveSimSeed(options.seed, i);
    const random = createSeededRandom(seed);
    const result = await runFleetSchedule(scenario, (enabled) => Math.floor(random() * enabled));
    result.seed = seed;
    schedules += 1;
    if (result.violations.length > 0) {
      failures.push(result);
      if (options.stopOnFirstViolation) break;
    }
  }
  return { schedules, truncated: false, failures };
}

export function replayFleetSchedule(scenario: FleetScenario, choices: readonly number[]): Promise<FleetScheduleResult> {
  return runFleetSchedule(scenario, (_enabled, step) => choices[step] ?? 0);
}

export function formatFleetFailure(result: FleetScheduleResult): string {
  const lines = [
    `fleet-sim schedule failed (seed=${result.seed ?? 'n/a'})`,
    `replay: replayFleetSchedule(scenario, [${result.choices.join(', ')}])`,
    'violations:',
    ...result.violations.map(
      (v) =>
        `  - ${v.invariant}${v.issue === undefined ? '' : ` #${v.issue}`}${v.step === undefined ? '' : ` @step ${v.step}`}: ${v.detail}`,
    ),
    'trace:',
    ...result.trace.map((s) => `  ${s.index} ${s.actor} ${s.detail}`),
  ];
  return lines.join('\n');
}

/** Claims from `lane` until the queue is empty (or `maxClaims`), releasing each claim with `outcome`. */
export function claimAndReleaseActor(
  lane: string,
  outcome: QueueReleaseOutcome = 'done',
  maxClaims = Infinity,
): FleetActor {
  return async ({ queue }) => {
    for (let claimed = 0; claimed < maxClaims; claimed += 1) {
      const claim = await queue.claimNext(lane);
      if (!claim) return;
      await queue.release(claim.issue, outcome);
    }
  };
}
