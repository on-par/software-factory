import type { ModelRouter, RouterResult } from '../router/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { FailoverReason } from '../types/index.js';

type Log = (type: 'worker_failover', msg: string, extra: { failoverReason: FailoverReason }) => void;

/** oc-08's cross-harness order for leaving OpenCode: the first build_claude worker, else the first
 *  build_codex worker unless codex is disabled. Shared by in-phase failover and runIssue's
 *  pre-BUILD breaker gate (#2891). */
export function pickOpencodeFallback(
  router: ModelRouter,
  codexDisabled?: boolean,
): { route: 'claude' | 'codex'; task: 'build_claude' | 'build_codex'; model: string } | undefined {
  const claudeModel = router.resolveAll('build_claude')[0];
  if (claudeModel) return { route: 'claude', task: 'build_claude', model: claudeModel };
  const codexModel = codexDisabled ? undefined : router.resolveAll('build_codex')[0];
  return codexModel ? { route: 'codex', task: 'build_codex', model: codexModel } : undefined;
}

/**
 * Where an OpenCode BUILD continues once every build_opencode worker is capped (#2885): the first
 * build_claude worker, else the first build_codex worker. Undefined means rethrow the original
 * failure: the repo pinned the route (ADR-0092), auto-failover is off, or no target worker exists.
 */
export async function failOverOpencodeBuild(opts: {
  router: ModelRouter;
  reason: FailoverReason;
  fromModel: string;
  runOpts: Parameters<ModelRouter['run']>[2];
  prompts: { claude: () => string; codex: () => string };
  build: {
    steering?: ConsumedSteering;
    log: Log;
    routePinned?: boolean;
    autoFailover?: { enabled: boolean };
    codexDisabled?: boolean;
  };
}): Promise<{ route: 'claude' | 'codex'; result: RouterResult } | undefined> {
  const { router, reason, fromModel } = opts;
  if (opts.build.routePinned === true || (opts.build.autoFailover && !opts.build.autoFailover.enabled))
    return undefined;
  const target = pickOpencodeFallback(router, opts.build.codexDisabled);
  if (!target) return undefined;
  opts.build.log(
    'worker_failover',
    `OpenCode build workers exhausted (${reason}) — continuing on ${target.route}: ` +
      `from_model=${fromModel} to_model=${target.model} ` +
      `from_route=build_opencode to_route=${target.task} reason=${reason}`,
    { failoverReason: reason },
  );
  const prompt = applySteering(opts.prompts[target.route](), opts.build.steering);
  // modelOverride must be the chosen model: runOpts may hold the opencode pin.
  const result = await router.run(target.task, prompt, {
    ...opts.runOpts,
    retryCause: 'failover',
    modelOverride: target.model,
  });
  return { route: target.route, result };
}
