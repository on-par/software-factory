import type { ModelExecutor, ModelExecutorContext, FailoverReason } from './index.js';
import type { TaskType } from '../types/index.js';

type StubStep =
  | { output: string; effect?: (ctx: ModelExecutorContext) => Promise<void> | void }
  | { fail: FailoverReason };

export interface StubModelExecutorOptions {
  /** Scripted steps per task type, consumed in order across successive runModel calls. */
  scripts?: Partial<Record<TaskType, StubStep[]>>;
  /** Fallback output for a task type with no (remaining) scripted steps. */
  defaultOutput?: string;
}

export class StubModelExecutor implements ModelExecutor {
  readonly calls: { model: string; prompt: string; task: TaskType }[] = [];
  private queues = new Map<TaskType, StubStep[]>();

  constructor(private options: StubModelExecutorOptions = {}) {
    for (const [task, steps] of Object.entries(options.scripts ?? {})) {
      this.queues.set(task as TaskType, [...(steps as StubStep[])]);
    }
  }

  async runModel(model: string, prompt: string, ctx: ModelExecutorContext): Promise<string> {
    this.calls.push({ model, prompt, task: ctx.task });
    const step = this.queues.get(ctx.task)?.shift();
    if (step && 'fail' in step) {
      const err: any = new Error(`stub failure: ${step.fail}`);
      err.reason = step.fail;
      err.exitCode = 1;
      throw err;
    }
    if (step && 'output' in step) {
      await step.effect?.(ctx);
      return step.output;
    }
    if (this.options.defaultOutput !== undefined) return this.options.defaultOutput;
    throw new Error(`StubModelExecutor: no scripted step or defaultOutput for task '${ctx.task}'`);
  }
}
