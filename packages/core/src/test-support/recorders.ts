import { ModelRouter, type ModelExecutor } from '../router/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { CheckerContext } from '../checkers/index.js';

export type LoggedEvent = { type: string; msg: string; data?: { durationMs?: number } };
export const recordArgs = <A extends unknown[], R>(impl: (...args: A) => R) => {
  const calls: A[] = [];
  return { calls, fn: (...args: A): R => impl(...(calls.push(args), args)) };
};

export function recordingLog(events: LoggedEvent[]): NonNullable<CheckerContext['log']> {
  return (type, msg, data) => {
    events.push({ type, msg, data });
  };
}

export function sandboxRecordingRouter(models: ModelsConfig, routes: RoutesConfig, inner: ModelExecutor) {
  const sandboxes: (SandboxPolicy | undefined)[] = [];
  const executor: ModelExecutor = {
    runModel: (m, p, ctx) => {
      sandboxes.push(ctx.sandbox);
      return inner.runModel(m, p, ctx);
    },
  };
  return { router: new ModelRouter(models, routes, false, executor), sandboxes };
}
