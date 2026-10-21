import type { HarnessLiveUsage } from '../harness/index.js';
import { type ModelRegistry, priceUsage } from '../models/index.js';
import type { RouterAttempt } from './executor-error.js';

/** Called with the priced running cost of the live session; return true once the session has been stopped (#3320). */
export type BudgetGuard = (runningUsd: number, calls: number) => boolean;

export interface BudgetStop {
  runningUsd: number;
  calls: number;
  usage: HarnessLiveUsage;
}

export interface BudgetWatch {
  onLiveUsage: (cumulative: HarnessLiveUsage) => void;
  readonly stop: BudgetStop | undefined;
  /** Throws BudgetStopError when the guard has stopped the session (used on the success path). */
  throwIfStopped(): void;
}

/** Thrown by the router when the budget guard stopped an attempt; never retried or failed over. */
export class BudgetStopError extends Error {
  override name = 'BudgetStopError';
  constructor(
    readonly model: string,
    readonly stop: BudgetStop,
    readonly attempts: RouterAttempt[],
  ) {
    super(`budget guard stopped ${model} at model call ${stop.calls}`);
  }
}

export function isBudgetStopError(err: unknown): err is BudgetStopError {
  return err instanceof BudgetStopError || (err instanceof Error && err.name === 'BudgetStopError');
}

/** Price each cumulative live update like a cost row and hand it to the guard; remember the first stop. */
export function watchBudget(
  registry: Pick<ModelRegistry, 'estimateCost'>,
  model: string,
  guard: BudgetGuard,
): BudgetWatch {
  let stop: BudgetStop | undefined;
  return {
    onLiveUsage(u) {
      if (stop) return;
      const { cost } = priceUsage(registry, model, u.inputTokens, u.outputTokens, u);
      if (cost === null || !Number.isFinite(cost)) return;
      if (guard(cost, u.calls)) stop = { runningUsd: cost, calls: u.calls, usage: u };
    },
    get stop() {
      return stop;
    },
    throwIfStopped() {
      if (stop) throw new BudgetStopError(model, stop, []);
    },
  };
}
