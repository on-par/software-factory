// src/phases/build.ts — BUILD phase: worker model implements the frozen spec

import { readFile } from 'node:fs/promises';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { captureDiffBase, collectDesignDiff } from '../checkers/design-smells.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { readDesignArtifact, renderDesignGrounding } from '../design/index.js';
import { laneEnv } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import { routerFailureOf } from '../router/executor-error.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxEventType, SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { Constitution, FailoverReason } from '../types/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import { UNTRUSTED_ISSUE_BODY_NOTICE } from '../utils/untrusted-input.js';

export interface BuildResult {
  ok: boolean;
  model: string;
  route: 'codex' | 'claude' | 'opencode';
  escalate?: string;
  /** Set on a non-escalation build failure; 'no_diff' = worker produced no diff,
   *  'junk_only_diff' = worker changed only generated/cache files. */
  reason?: 'no_diff' | 'junk_only_diff';
  /** Run-start HEAD SHA captured before the worker ran (#1162) — checkPhase's
   *  fallback diff base for remote-less checkouts (#1211). */
  diffBase?: string;
}

export async function buildPhase(opts: Parameters<typeof buildPhaseImpl>[0]): Promise<BuildResult> {
  return withLifecycle(
    {
      bus: opts.bus,
      phase: 'build',
      laneId: opts.laneId,
      issueId: opts.issue,
      worktreePath: opts.worktree,
      log: opts.log,
    },
    () => buildPhaseImpl(opts),
    (r) => r.ok,
    (r) =>
      r.ok
        ? `build complete (model ${r.model})`
        : r.reason === 'junk_only_diff'
          ? 'build failed: worker changed only generated/cache files'
          : r.reason === 'no_diff'
            ? 'build failed: worker produced no diff'
            : `build escalated: ${r.escalate ?? 'unknown'}`,
  );
}

async function buildPhaseImpl(opts: {
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  branch: string;
  constitution: Constitution | null;
  route: 'codex' | 'claude' | 'opencode';
  router: ModelRouter;
  log: (
    type: EventKind,
    msg: string,
    extra?: {
      failoverReason?: FailoverReason;
      model?: string;
      tokens?: { input: number; output: number };
      durationMs?: number;
    },
  ) => void;
  timeoutSeconds?: number;
  skipCI?: boolean;
  /** Local-only workspace runs (#508): use the commit-only prompt on every
   *  route — never instruct the worker to push, open a PR, or watch CI.
   *  Forces commit-only even when publishFromBuild is set. */
  disablePublish?: boolean;
  /** Opt-in (#1867, build.publishFromBuild): the claude route sends the publishing prompt (push, open PR, wait for CI). Default false = commit-only on every route. Ignored when disablePublish is set. */
  publishFromBuild?: boolean;
  modelOverride?: string;
  /** Cross-provider Codex fallback used when a Claude worker is capped or unavailable. */
  codexFallbackModel?: string;
  onProviderFailure?: (info: { provider: string; reason: FailoverReason }) => void | Promise<void>;
  sandbox?: SandboxPolicy;
  steering?: ConsumedSteering;
  appPort?: number;
  /** Stable lane URL from the factory proxy (e.g. http://<lane>.factory.localhost), when running. */
  appBaseUrl?: string;
  codexDisabled?: boolean;
  autoFailover?: {
    enabled: boolean;
    fallbackModel?: string;
    onQuotaExhausted?: (info: { provider: string; reason: FailoverReason }) => void | Promise<void>;
  };
  onPgid?: (pgid: number) => void;
  /** Local-only mode: use the compact local-small prompt on the codex route. */
  localOnly?: boolean;
  /** Lane id stamped onto emitted lifecycle events; defaults to `issue-<issue>` (#591). */
  laneId?: string;
  /** Per-run id minted by runIssue; becomes SharedCompilationId=factory-<runId> for .NET lanes (#1910). */
  runId?: string;
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
  /** Injectable for tests; defaults to collectDesignDiff. */
  collectDiff?: typeof collectDesignDiff;
  /** Injectable for tests; defaults to captureDiffBase. */
  captureBase?: typeof captureDiffBase;
}): Promise<BuildResult> {
  const {
    issue,
    worktree,
    specPath,
    branch,
    constitution,
    router,
    log,
    timeoutSeconds,
    skipCI,
    disablePublish,
    publishFromBuild,
    modelOverride: modelOverrideOpt,
    codexFallbackModel,
    onProviderFailure,
    sandbox,
    steering,
    appPort,
    appBaseUrl,
    onPgid,
    runId,
  } = opts;
  let route = opts.route;

  const constitutionCtx = buildConstitutionContext(constitution);
  const spec = await readFile(specPath, 'utf-8').catch(() => '');
  const designArtifact = await readDesignArtifact(specPath);
  const designGrounding = designArtifact ? renderDesignGrounding(designArtifact) : '';
  if (designArtifact) {
    log(
      'design_artifact_received',
      `design artifact received (open questions: ${designArtifact.openQuestions.length}, ` +
        `target types: ${designArtifact.targetTypes.length}, ` +
        `signatures: ${designArtifact.signatures.length}, ` +
        `call edges: ${designArtifact.callGraph.length})`,
    );
  }
  const localOnly = opts.localOnly ?? false;
  const isCodexDisabled = opts.codexDisabled ?? false;

  // Commit-only unless the repo opts in (#1867); local-only always stays commit-only (#508).
  const claudeRoutePrompt = (): string =>
    publishFromBuild && !disablePublish
      ? buildClaudePrompt({ issue, branch, specPath, constitutionCtx, skipCI, appPort, appBaseUrl, designGrounding })
      : buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding });
  let prompt: string;
  let taskType: 'build_codex' | 'build_claude' | 'build_opencode';

  let modelOverride = modelOverrideOpt;
  if (route === 'codex' && isCodexDisabled) {
    log('warn', 'codex unavailable — falling back to claude');
    route = 'claude';
    // A Codex-harness override would put that model first in the claude route's chain and run it
    // anyway (an override skips the tier's provider filter), so a pinned or fallback codex model
    // cannot ride the flip. Drop it and let the claude route pick its own worker (#1367).
    if (modelOverride && router.registryRef.isCodexModel(modelOverride)) {
      log(
        'model_override_ignored',
        `build model ${modelOverride} needs the codex route, which is unavailable — using the claude route's default worker`,
      );
      modelOverride = undefined;
    }
  }

  if (route === 'codex') {
    taskType = 'build_codex';
    prompt = localOnly
      ? buildLocalSmallPrompt({ issue, branch, spec })
      : buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding });
  } else if (route === 'opencode') {
    taskType = 'build_opencode';
    prompt = buildOpencodePrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding });
  } else {
    taskType = 'build_claude';
    prompt = claudeRoutePrompt();
  }

  prompt = applySteering(prompt, steering);

  log('build', `Starting build phase (route: ${route})`);
  if (sandbox) {
    log(
      'sandbox',
      `containment active (runtime ${sandbox.runtime}, net ${sandbox.allowHosts.length ? 'allow-list' : 'deny-all'})`,
    );
  }

  const runOpts = {
    worktree,
    timeoutSeconds: timeoutSeconds ?? 7200,
    modelOverride,
    sandbox,
    onSandboxEvent: (type: SandboxEventType, detail: string) => log(type, detail),
    onLog: (msg: string) => log('router', msg),
    env: laneEnv(appPort, process.env, appBaseUrl, worktree, runId),
    onPgid,
    onProviderFailure,
  };

  // Captured before the worker runs so the post-build diff has a correct base
  // even in checkouts with no origin/main or origin/master (#1162).
  const fallbackBaseRef = await (opts.captureBase ?? captureDiffBase)(worktree);

  let result: RouterResult;
  try {
    result = await router.run(taskType, prompt, runOpts);
  } catch (err) {
    const routerFailure = routerFailureOf(err);
    const reason = routerFailure?.reason;
    const attempts = routerFailure?.attempts;
    // These all indicate a provider problem rather than a bad task. Preserve
    // the frozen spec and continue on the other provider when one is available.
    const providerFailure =
      reason === 'usage_cap' ||
      reason === 'rate_limit' ||
      reason === 'timeout' ||
      reason === 'unavailable' ||
      reason === 'local_auth';
    // Only swap when we actually ran the codex route and it was exhausted on a
    // quota reason. The router only throws after trying every eligible codex
    // worker, so reaching here already means "no Codex-harness worker remains".
    if (taskType === 'build_claude' && providerFailure) {
      if (opts.autoFailover && !opts.autoFailover.enabled) throw err;
      const fallback = codexFallbackModel ?? router.resolveAll('build_codex')[0];
      if (!fallback) throw err;
      log('worker_failover', `Claude build workers exhausted (${reason}) — continuing on Codex: to_model=${fallback}`, {
        failoverReason: reason,
      });
      route = 'codex';
      result = await router.run(
        'build_codex',
        buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding }),
        { ...runOpts, retryCause: 'failover', modelOverride: fallback },
      );
    } else if (taskType !== 'build_codex' || !providerFailure) throw err;
    else {
      if (opts.autoFailover && !opts.autoFailover.enabled) throw err;
      const fromModel = attempts?.at(-1)?.model ?? 'unknown';
      const provider = router.registryRef.get(fromModel)?.provider ?? 'openai';
      const fallback = opts.autoFailover?.fallbackModel;
      const toModel =
        fallback && router.resolveAll('build_claude').includes(fallback)
          ? fallback
          : router.resolveAll('build_claude')[0];
      if (!toModel) throw err;
      log(
        'worker_failover',
        `Codex build workers exhausted (${reason}) — continuing on claude: ` +
          `from_model=${fromModel} to_model=${toModel} ` +
          `from_route=build_codex to_route=build_claude reason=${reason}`,
        { failoverReason: reason },
      );
      try {
        await opts.autoFailover?.onQuotaExhausted?.({ provider, reason });
      } catch (breakerErr) {
        // Best-effort circuit-breaker bookkeeping — a write failure here must
        // never turn a successful codex→claude failover into a hard build
        // failure.
        log('warn', `provider breaker callback failed (non-fatal): ${(breakerErr as Error).message}`);
      }
      route = 'claude';
      const claudePrompt = applySteering(claudeRoutePrompt(), steering);
      result = await router.run('build_claude', claudePrompt, {
        ...runOpts,
        retryCause: 'failover',
        ...(toModel === fallback ? { modelOverride: fallback } : {}),
      });
    }
  }

  for (const f of failoversFrom(result.attempts)) {
    log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }

  if (isEscalation(result.output)) {
    const escalateLine = escalationLine(result.output);
    log('escalate', escalateLine ?? 'build escalated');
    return { ok: false, model: result.model, route, escalate: escalateLine };
  }

  // Second positional arg stays undefined so injected test stubs with the old
  // 1-arg shape still typecheck against `typeof collectDesignDiff`.
  const diff = await (opts.collectDiff ?? collectDesignDiff)(worktree, undefined, { fallbackBaseRef });
  if (diff.skipReason) {
    log('build', `diff post-condition skipped — ${diff.skipReason}`);
  } else if (diff.text === '') {
    const junkOnly = (diff.excludedPaths?.length ?? 0) > 0;
    const detail = junkOnly
      ? `worker changed only generated/cache files against ${diff.baseRef} (${diff.excludedPaths!.slice(0, 10).join(', ')}); no implementation was produced`
      : `worker produced no diff against ${diff.baseRef}; no implementation was produced`;
    log('fail', detail);
    return { ok: false, model: result.model, route, reason: junkOnly ? 'junk_only_diff' : 'no_diff' };
  }

  log('build', `Build complete with model ${result.model}`, { model: result.model });
  return { ok: true, model: result.model, route, diffBase: fallbackBaseRef };
}

export function buildLocalSmallPrompt(opts: { issue: number; branch: string; spec: string }): string {
  const { issue, branch, spec } = opts;
  return `Local-small build for issue #${issue}.
You are in the isolated worktree for branch ${branch}.
Do one small implementation pass from this frozen spec, then commit.

Rules:
- Prefer one or two files.
- Inspect only the files you need.
- Make the smallest change that satisfies the acceptance criteria.
- Run one cheap verification command if available.
- Create exactly one git commit.
- Do not push, open a PR, or merge.
- If something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop.

${UNTRUSTED_ISSUE_BODY_NOTICE}

Frozen spec:
${compactForLocalModel(spec)}
`;
}

/** The opencode route uses the commit-only prompt verbatim (#1976). */
export function buildOpencodePrompt(opts: Parameters<typeof buildCommitOnlyPrompt>[0]): string {
  return buildCommitOnlyPrompt(opts);
}

export function buildCommitOnlyPrompt(opts: {
  issue: number;
  specPath: string;
  constitutionCtx: string;
  spec: string;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
}): string {
  const { issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding } = opts;
  return `Implement issue #${issue} from the frozen spec below (also saved at ${specPath}). It is the approved plan: follow it and stay within its scope, with no unrelated refactors or drive-by changes.

${constitutionCtx}

${UNTRUSTED_ISSUE_BODY_NOTICE}

## Spec
${spec}

## Rules
- Match the surrounding code style. Add or update the tests in the spec's Tests section.
- ${VERIFY_RULE}
- Commit atomically: one commit per independently testable functional change, with a clear conventional message. Never mix unrelated functional changes in one commit. A single-slice task yields exactly ONE commit.
- Do NOT push, do NOT open a pull request, do NOT merge. CHECK and SHIP run next.
- If something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop. If you are stuck, commit what safely builds and passes, say what is blocked in the commit message, and stop.
- Work directly. Use sub-agents only for genuinely independent work.

${promptTail(appPort, appBaseUrl, designGrounding)}`;
}

export function buildClaudePrompt(opts: {
  issue: number;
  branch: string;
  specPath: string;
  constitutionCtx: string;
  skipCI?: boolean;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
}): string {
  const { issue, branch, specPath, constitutionCtx, skipCI, appPort, appBaseUrl, designGrounding } = opts;
  return `Run fully autonomously in headless mode for issue #${issue}, BUILD phase.
You are ALREADY inside the isolated git worktree for branch ${branch} (cwd). Nobody is watching: never pause for permission or input.

${constitutionCtx}

The frozen, approved spec is at ${specPath}. Read it and follow it as the plan. Do not re-plan from the issue or wait on a plan gate. Stay within its scope. Auto-fix only high-confidence review findings. For uncertain ones, apply the conservative default and note the deferral in the PR body.

${UNTRUSTED_ISSUE_BODY_NOTICE}

- ${VERIFY_RULE}
- Commit atomically: one commit per independently testable functional change, with a clear conventional message. Never mix unrelated functional changes in one commit.
- Do NOT merge (the factory merges). Your session ends when you end your turn, so do not stop until: (1) branch ${branch} is pushed, (2) an open PR exists with 'Closes #${issue}' in its body, ${skipCI ? '(3) local verify passes (CI is intentionally skipped: do not block on GitHub Actions CI or escalate if CI cannot run), (4) the PR is ready.' : '(3) CI is green, (4) the PR is ready.'}
- If and only if something is genuinely ambiguous, print a line starting exactly with "ESCALATE:" followed by the question, then stop.

${promptTail(appPort, appBaseUrl, designGrounding)}`;
}

// Mirrors testsChecker's command order so BUILD verifies with what CHECK runs (#1976).
const VERIFY_RULE =
  'Verify with the command CHECK runs: `bash scripts/verify.sh --no-e2e` if scripts/verify.sh exists, ' +
  'otherwise the test script (`npm test`) or pytest, plus any verify command the constitution names. ' +
  'Fix failures before finishing and report the exact command and its output.';

function promptTail(appPort?: number, appBaseUrl?: string, designGrounding?: string): string {
  return `${headlessNote()}${appPort ? `\n\n${appPortNote(appPort, appBaseUrl)}` : ''}${designGrounding ? `\n\n${designGrounding}` : ''}`;
}

function headlessNote(): string {
  return `## Headless e2e (factory-managed run)
FACTORY_HEADLESS=1 and PLAYWRIGHT_HEADLESS=1 are set: never open a visible browser window. Any e2e or browser-runner config you write (Playwright, Cypress, etc.) must stay headless by default (keep \`headless: true\` or omit it), and never bake \`--headed\`, \`--ui\`, or \`cypress open\` into package.json scripts.`;
}

function appPortNote(appPort: number, appBaseUrl?: string): string {
  const baseUrlSentence = appBaseUrl
    ? `This lane owns port ${appPort}; its stable base URL is ${appBaseUrl} (via the factory proxy).`
    : `This lane owns port ${appPort} (base URL http://127.0.0.1:${appPort}).`;
  return `## Assigned app port
${baseUrlSentence} PORT and FACTORY_APP_PORT are set. Dev servers, previews and e2e config must read process.env.PORT (never hardcode 3000) and use a strict port (Vite: --strictPort; Next.js: -p ${appPort}) so a mismatch fails loudly.`;
}

function compactForLocalModel(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 6000) return trimmed;
  return `${trimmed.slice(0, 5600)}\n\n[truncated for local model: keep the implementation minimal and inspect files as needed]`;
}
