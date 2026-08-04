// packages/core/src/sim/model.ts — reusable fake ModelExecutor: per-call response,
// latency, and scripted failure, injected straight into ModelRouter.

import type { TaskType } from '../types/index.js';
import { ModelExecutorError } from '../router/executor-error.js';
import type { FailoverReason, ModelExecutor, ModelExecutorContext } from '../router/index.js';
import { applyLatency, realSimClock, type SimClock, type SimLatency } from './latency.js';

export interface SimModelStep {
  /** Resolved output for this call. Defaults to '' when omitted and `fail` is unset. */
  output?: string;
  /** When set, this call rejects with a typed ModelExecutorError carrying this reason. */
  fail?: FailoverReason;
  /** Overrides the rejection message (defaults to `sim failure: <reason>`). */
  message?: string;
  /** Per-call delay; overrides the executor-wide default. */
  latency?: SimLatency;
  /** Side effect run after the delay and before resolving/rejecting (e.g. write files, commit). */
  effect?: (ctx: ModelExecutorContext) => Promise<void> | void;
}

export interface SimModelCall {
  model: string;
  prompt: string;
  task: TaskType;
  /** The delay actually applied to this call, in ms. */
  latencyMs: number;
  /** True when the call rejected (scripted failure or script exhaustion). */
  failed: boolean;
}

export interface SimModelExecutorOptions {
  /** Scripted steps per task type, consumed in order across successive runModel calls. */
  scripts?: Partial<Record<TaskType, SimModelStep[]>>;
  /** Used for any call whose task-type script is empty or absent. */
  defaultStep?: SimModelStep;
  /** Default delay for every call that does not set its own. */
  latency?: SimLatency;
  /** Defaults to realSimClock. */
  clock?: SimClock;
}

export class SimModelExecutor implements ModelExecutor {
  readonly calls: SimModelCall[] = [];
  private queues = new Map<TaskType, SimModelStep[]>();
  private clock: SimClock;

  constructor(private options: SimModelExecutorOptions = {}) {
    this.clock = options.clock ?? realSimClock;
    for (const [task, steps] of Object.entries(options.scripts ?? {})) {
      this.queues.set(task as TaskType, [...(steps as SimModelStep[])]);
    }
  }

  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    const record: SimModelCall = { model, prompt, task: ctx.task, latencyMs: 0, failed: false };
    this.calls.push(record);

    const step = this.queues.get(ctx.task)?.shift() ?? this.options.defaultStep;
    if (!step) {
      record.failed = true;
      throw new Error(`SimModelExecutor: no scripted step or defaultStep for task '${ctx.task}'`);
    }

    record.latencyMs = await applyLatency(step.latency ?? this.options.latency, this.clock);
    await step.effect?.(ctx);

    if (step.fail) {
      record.failed = true;
      throw new ModelExecutorError(step.message ?? `sim failure: ${step.fail}`, step.fail, { exitCode: 1 });
    }

    return step.output ?? '';
  }
}

export function failOnCall(
  call: number,
  fail: FailoverReason,
  options?: { message?: string; output?: string; latency?: SimLatency },
): SimModelStep[] {
  const failingStep: SimModelStep = { fail, message: options?.message, latency: options?.latency };
  if (call < 1) return [failingStep];

  const passingStep: SimModelStep = { output: options?.output ?? '', latency: options?.latency };
  return [...Array.from({ length: call - 1 }, () => ({ ...passingStep })), failingStep];
}
