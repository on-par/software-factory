import { ModelRouter, type ModelExecutor } from '../router/index.js';
import type { ModelsConfig, RoutesConfig } from '../config/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import type { CheckerContext } from '../checkers/index.js';
export type LoggedEvent = {
  type: string;
  msg: string;
  data?: { durationMs?: number; cpuMs?: number; peakRssBytes?: number };
};
export const recordArgs = <F extends (...args: any[]) => any>(impl: F) => {
  const calls: Parameters<F>[] = [];
  const fn = (...args: Parameters<F>): ReturnType<F> => impl(...(calls.push(args), args));
  return { calls, fn };
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
