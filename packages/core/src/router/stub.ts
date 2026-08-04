import type { TaskType } from '../types/index.js';
import type { FailoverReason, ModelExecutor, ModelExecutorContext } from './index.js';
import { SimModelExecutor, type SimModelStep } from '../sim/index.js';

type StubStep =
  | { output: string; effect?: (ctx: ModelExecutorContext) => Promise<void> | void }
  | { fail: FailoverReason; effect?: (ctx: ModelExecutorContext) => Promise<void> | void };

export interface StubModelExecutorOptions {
  /** Scripted steps per task type, consumed in order across successive runModel calls. */
  scripts?: Partial<Record<TaskType, StubStep[]>>;
  /** Fallback output for a task type with no (remaining) scripted steps. */
  defaultOutput?: string;
}

function toSimStep(step: StubStep): SimModelStep {
  if ('fail' in step) return { fail: step.fail, effect: step.effect, message: `stub failure: ${step.fail}` };
  return { output: step.output, effect: step.effect };
}

export class StubModelExecutor implements ModelExecutor {
  readonly calls: { model: string; prompt: string; task: TaskType }[] = [];
  private sim: SimModelExecutor;

  constructor(options: StubModelExecutorOptions = {}) {
    const scripts: Partial<Record<TaskType, SimModelStep[]>> = {};
    for (const [task, steps] of Object.entries(options.scripts ?? {})) {
      scripts[task as TaskType] = (steps as StubStep[]).map(toSimStep);
    }
    this.sim = new SimModelExecutor({
      scripts,
      defaultStep: options.defaultOutput !== undefined ? { output: options.defaultOutput } : undefined,
    });
  }

  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    this.calls.push({ model, prompt, task: ctx.task });
    try {
      return await this.sim.runModel(model, prompt, ctx);
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === `SimModelExecutor: no scripted step or defaultStep for task '${ctx.task}'`
      ) {
        throw new Error(`StubModelExecutor: no scripted step or defaultOutput for task '${ctx.task}'`);
      }
      throw err;
    }
  }
}
