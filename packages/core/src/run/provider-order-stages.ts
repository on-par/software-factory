// packages/core/src/run/provider-order-stages.ts — runIssue's seams for models.providerOrder (#3338).
// Per-pick PLAN/BUILD/CHECK options, the worktree restore that precedes a rerun, and the CHECK
// stage wrapper. The picker and rerun loop live in provider-breaker-gate.ts.

import type { ModelRegistry } from '../models/index.js';
import { subscriptionProviderOf, type ProviderOrder } from '../config/provider-order.js';
import { routeForBuildModel, type EffectiveModelPins } from '../config/repo.js';
import type { ModelRouter } from '../router/index.js';
import type { ProviderBreaker } from '../router/breaker.js';
import { captureWorktreeState, resetWorktreeState } from '../router/worktree-state.js';
import type { ExecFn } from '../utils/exec.js';
import type { EventKind } from '../events/kinds.js';
import type { ProviderFailoverPayload } from '../events/payloads.js';
import type { WorkKey } from '../work/work-key.js';
import type { BuildRoute } from './outcome.js';
import {
  pickOrderedProvider,
  runWithProviderFailover,
  type FailoverStage,
  type ProviderPick,
} from './provider-breaker-gate.js';
import type { ProviderProbe } from './provider-probe.js';

type StageLog = (type: EventKind, msg: string, extra?: { providerFailover?: ProviderFailoverPayload }) => void;

export type StageRunner = <T>(
  stage: FailoverStage,
  attempt: (pick: ProviderPick | undefined) => Promise<T>,
  hooks?: { beforeRerun?: () => Promise<boolean> },
) => Promise<T>;

/** Runs a stage through the provider failover loop when `order` is set; otherwise just once with no pick (today's call). */
export function providerStageRunner(
  deps: { router: ModelRouter; breaker: ProviderBreaker; probe?: ProviderProbe; log: StageLog; issue: WorkKey },
  order: ProviderOrder | undefined,
): StageRunner {
  return (stage, attempt, hooks) =>
    order ? runWithProviderFailover({ ...deps, order }, stage, attempt, hooks) : attempt(undefined);
}

/** The repo pin when it runs on the picked provider, else the pick's model; the pin itself when nothing was picked. */
function modelForPick(
  pick: ProviderPick | undefined,
  pin: string | undefined,
  registry: ModelRegistry,
): string | undefined {
  if (!pick) return pin;
  return pin !== undefined && subscriptionProviderOf(pin, registry.get(pin)) === pick.provider ? pin : pick.model;
}

/** PLAN's model, fallbacks and skip set for a pick; without a pick, today's pin, planFallback and stage-gate skip. */
export function planPickOptions(
  pick: ProviderPick | undefined,
  pins: EffectiveModelPins,
  registry: ModelRegistry,
  gateSkip: ReadonlySet<string> | undefined,
): { modelOverride?: string; modelFallbacks?: string[]; skipProviders?: ReadonlySet<string> } {
  if (!pick) {
    return {
      modelOverride: pins.plan,
      modelFallbacks: pins.planFallback ? [pins.planFallback] : undefined,
      skipProviders: gateSkip?.size ? gateSkip : undefined,
    };
  }
  return {
    modelOverride: modelForPick(pick, pins.plan, registry),
    modelFallbacks: undefined,
    skipProviders: pick.skipped.size ? pick.skipped : undefined,
  };
}

/** BUILD's route and model for a pick; the route follows the model's harness (the pre-BUILD fallback route if it has none). */
export function buildTargetForPick(
  pick: ProviderPick,
  pin: string | undefined,
  registry: ModelRegistry,
  fallbackRoute: BuildRoute,
): { route: BuildRoute; model: string | undefined } {
  const model = modelForPick(pick, pin, registry);
  const route = routeForBuildModel(registry, model);
  return route ? { route, model } : { route: fallbackRoute, model: undefined };
}

/** BUILD's route, model and pin flag for a pick; without a pick, the already-resolved today's target. */
export function buildPickOptions(
  pick: ProviderPick | undefined,
  current: { route: BuildRoute; model: string | undefined },
  pin: string | undefined,
  registry: ModelRegistry,
  fallbackRoute: BuildRoute,
): { route: BuildRoute; modelOverride: string | undefined; pinnedModel: boolean } {
  const target = pick ? buildTargetForPick(pick, pin, registry, fallbackRoute) : current;
  return {
    route: target.route,
    modelOverride: target.model,
    pinnedModel: target.model !== undefined && target.model === pin,
  };
}

/** Snapshots the worktree now and returns the `beforeRerun` hook that restores it; the hook refuses (false) without a snapshot. */
export async function worktreeRestorer(
  gitExec: ExecFn,
  worktree: string,
  log: (type: EventKind, msg: string) => void,
): Promise<() => Promise<boolean>> {
  const snapshot = await captureWorktreeState(gitExec, worktree, (m) => log('router', m));
  return async () => {
    if (!snapshot) return false;
    const { didReset, tracePath } = await resetWorktreeState(gitExec, worktree, snapshot, (m) => log('router', m));
    if (didReset) {
      log(
        'router',
        `worktree restored to the stage start before the rerun${tracePath ? ` (attempt trace: ${tracePath})` : ''}`,
      );
    }
    return true;
  };
}

/**
 * CHECK under providerOrder (#3338): every router call in an attempt skips the providers passed over ahead of the pick,
 * and the rework worker moves to the worker pick when the built model's provider was passed over. The stage skip set
 * is always cleared afterwards so it never leaks into SHIP's CI rework.
 */
export async function runCheckStage<O extends { reworkRoute?: BuildRoute; reworkModel?: string }, R>(
  run: StageRunner,
  deps: { router: ModelRouter; breaker: ProviderBreaker; probe?: ProviderProbe; log?: StageLog; order: ProviderOrder },
  checkPhase: (opts: O) => Promise<R>,
  opts: O,
  restore: () => Promise<boolean>,
): Promise<R> {
  const registry = deps.router.registryRef;
  const attempt = async (pick: ProviderPick | undefined): Promise<R> => {
    deps.router.setStageSkipProviders(pick?.skipped);
    const builtProvider = opts.reworkModel ? registry.get(opts.reworkModel)?.provider : undefined;
    if (!pick || !builtProvider || !pick.skipped.has(builtProvider)) return checkPhase(opts);
    const worker = await pickOrderedProvider(deps, deps.order, 'build', new Set());
    const reworkRoute = routeForBuildModel(registry, worker?.model);
    return checkPhase(worker && reworkRoute ? { ...opts, reworkRoute, reworkModel: worker.model } : opts);
  };
  try {
    return await run('check', attempt, { beforeRerun: restore });
  } finally {
    deps.router.setStageSkipProviders(undefined);
  }
}
