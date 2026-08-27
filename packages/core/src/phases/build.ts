// src/phases/build.ts — BUILD phase: worker model implements the frozen spec

import { readFile } from 'node:fs/promises';

import { type LifecycleBus, withLifecycle } from '../bus/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { readDesignArtifact, renderDesignGrounding } from '../design/index.js';
import { laneEnv } from '../environment/index.js';
import type { EventKind } from '../events/kinds.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxEventType, SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { Constitution, FailoverReason } from '../types/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';

export interface BuildResult {
  ok: boolean;
  model: string;
  route: 'codex' | 'claude' | 'opencode';
  escalate?: string;
}

export async function buildPhase(opts: Parameters<typeof buildPhaseImpl>[0]): Promise<BuildResult> {
  return withLifecycle(
    { bus: opts.bus, phase: 'build', laneId: opts.laneId, issueId: opts.issue, worktreePath: opts.worktree },
    () => buildPhaseImpl(opts),
    (r) => r.ok,
    (r) => (r.ok ? `build complete (model ${r.model})` : `build escalated: ${r.escalate ?? 'unknown'}`),
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
    extra?: { failoverReason?: FailoverReason; model?: string; tokens?: { input: number; output: number } },
  ) => void;
  timeoutSeconds?: number;
  skipCI?: boolean;
  /** Local-only workspace runs (#508): use the commit-only prompt on every
   *  route — never instruct the worker to push, open a PR, or watch CI. */
  disablePublish?: boolean;
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
  /** Lifecycle bus to emit onto; defaults to the process-wide `lifecycleBus` (#591). */
  bus?: LifecycleBus;
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
    modelOverride,
    codexFallbackModel,
    onProviderFailure,
    sandbox,
    steering,
    appPort,
    appBaseUrl,
    onPgid,
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

  let prompt: string;
  let taskType: 'build_codex' | 'build_claude' | 'build_opencode';

  if (route === 'codex' && isCodexDisabled) {
    log('warn', 'codex unavailable — falling back to claude');
    route = 'claude';
  }

  if (route === 'codex') {
    taskType = 'build_codex';
    prompt = localOnly
      ? `Local-small build for issue #${issue}.
You are in the isolated worktree for branch ${branch}.
Do one small implementation pass from this frozen spec, then commit.

Rules:
- Prefer one or two files.
- Inspect only the files you need.
- Make the smallest change that satisfies the acceptance criteria.
- Run one cheap verification command if available.
- Create exactly one git commit.
- Do not push, open a PR, or merge.

Frozen spec:
${compactForLocalModel(spec)}
`
      : buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding });
  } else if (route === 'opencode') {
    taskType = 'build_opencode';
    prompt = buildOpencodePrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding });
  } else {
    taskType = 'build_claude';
    prompt = disablePublish
      ? buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding })
      : buildClaudePrompt({
          issue,
          branch,
          specPath,
          constitutionCtx,
          skipCI,
          appPort,
          appBaseUrl,
          designGrounding,
        });
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
    env: laneEnv(appPort, process.env, appBaseUrl),
    onPgid,
    onProviderFailure,
  };

  let result: RouterResult;
  try {
    result = await router.run(taskType, prompt, runOpts);
  } catch (err) {
    const reason = (err as { reason?: FailoverReason }).reason;
    const attempts = (err as { attempts?: RouterResult['attempts'] }).attempts;
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
      taskType = 'build_codex';
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
      taskType = 'build_claude';
      const claudePrompt = applySteering(
        disablePublish
          ? buildCommitOnlyPrompt({ issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding })
          : buildClaudePrompt({
              issue,
              branch,
              specPath,
              constitutionCtx,
              skipCI,
              appPort,
              appBaseUrl,
              designGrounding,
            }),
        steering,
      );
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

  log('build', `Build complete with model ${result.model}`, { model: result.model });
  return { ok: true, model: result.model, route };
}

function buildOpencodePrompt(opts: {
  issue: number;
  specPath: string;
  constitutionCtx: string;
  spec: string;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
}): string {
  const { issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding } = opts;
  return `Implement issue #${issue} exactly per the frozen spec at ${specPath} in this repository.
Read the full spec before writing any code — it is the approved plan; do not deviate.

${constitutionCtx}

## Spec
${spec}

Match surrounding code style and idioms. Add or update the tests described in the
spec's Tests section and actually run them — report the exact command and its output.
If the repo has a fast verify path, run \`scripts/verify.sh --no-e2e\` (NOT bare
\`scripts/verify.sh\` or \`npm test\` — those run the full integration suite, which
has a known intermittent multi-hour hang; see #739) and fix failures before
finishing. Real CI still runs the full suite on the PR, so this is safe.

When everything passes, commit your work. Commit atomically: create one commit
per independently testable functional change, each with a clear, conventional
message describing what changed and why. Never mix unrelated functional changes
in the same commit. A small single-slice task still yields exactly ONE commit —
do not split one functional change across filler commits.

Do NOT push, do NOT open a pull request, do NOT merge — a separate checker and
ship phase handles that next.

Stay strictly within the spec's scope: no unrelated refactors, no drive-by changes.
If you get genuinely stuck, commit whatever safely builds/passes so far with a
message explaining what's blocked, and stop there.

Keep sub-agent/parallel-task usage modest: only fan out when a piece of work is
genuinely independent and parallelizable. Prefer doing the work directly over
spawning sub-agents for a single small issue — this keeps token usage efficient.

${headlessNote()}${appPort ? `\n\n${appPortNote(appPort, appBaseUrl)}` : ''}${designGrounding ? `\n\n${designGrounding}` : ''}`;
}

function buildCommitOnlyPrompt(opts: {
  issue: number;
  specPath: string;
  constitutionCtx: string;
  spec: string;
  appPort?: number;
  appBaseUrl?: string;
  designGrounding?: string;
}): string {
  const { issue, specPath, constitutionCtx, spec, appPort, appBaseUrl, designGrounding } = opts;
  return `Implement issue #${issue} exactly per the frozen spec at ${specPath} in this repository.
Read the full spec before writing any code — it is the approved plan; do not deviate.

${constitutionCtx}

## Spec
${spec}

Match surrounding code style and idioms. Add or update the tests described in the
spec's Tests section and actually run them — report the exact command and its output.
If the repo has a fast verify path, run \`scripts/verify.sh --no-e2e\` (NOT bare
\`scripts/verify.sh\` or \`npm test\` — those run the full integration suite, which
has a known intermittent multi-hour hang; see #739) and fix failures before
finishing. Real CI still runs the full suite on the PR, so this is safe.

When everything passes, commit your work. Commit atomically: create one commit
per independently testable functional change, each with a clear, conventional
message describing what changed and why. Never mix unrelated functional changes
in the same commit. A small single-slice task still yields exactly ONE commit —
do not split one functional change across filler commits.

Do NOT push, do NOT open a pull request, do NOT merge — a separate checker and
ship phase handles that next.

Stay strictly within the spec's scope: no unrelated refactors, no drive-by changes.
If you get genuinely stuck, commit whatever safely builds/passes so far with a
message explaining what's blocked, and stop there.

Keep sub-agent/parallel-task usage modest: only fan out when a piece of work is
genuinely independent and parallelizable. Prefer doing the work directly over
spawning sub-agents for a single small issue — this keeps token usage efficient.

${headlessNote()}${appPort ? `\n\n${appPortNote(appPort, appBaseUrl)}` : ''}${designGrounding ? `\n\n${designGrounding}` : ''}`;
}

function buildClaudePrompt(opts: {
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
  return `/ship-it ${issue} — Run fully autonomously in headless mode, BUILD phase.
You are ALREADY inside the isolated git worktree for issue ${issue} (branch ${branch},
cwd is this worktree), so SKIP ship-it's worktree-creation step.

${constitutionCtx}

A frozen, already-approved spec exists at ${specPath} (written by a separate planning pass)
— read it and treat it as your go/no-go plan; do NOT re-derive your own plan from the
issue or block on any plan gate. Auto-fix only high-confidence review findings; for
uncertain findings apply the conservative default and note the deferral in the PR body.
Never pause for permission or input — nobody is watching this session.

Commit atomically: one commit per independently testable functional change, each
with a clear conventional message; never mix unrelated functional changes in the
same commit. A single-slice task still yields one clear commit.

Stop at a green, ready-for-review PR — do NOT merge (the factory handles merging).
CRITICAL: your session terminates the moment you end your turn, so NEVER end your
turn after an intermediate step. Before ending: (1) branch ${branch} is pushed,
(2) open PR exists with 'Closes #${issue}' in its body, ${skipCI ? '(3) local verify passes (CI is intentionally skipped — do NOT block on GitHub Actions CI, do NOT escalate if CI cannot run), (4) PR ready.' : '(3) CI is green, (4) PR ready.'}

If and ONLY IF you hit something genuinely ambiguous, print a line starting exactly
with "ESCALATE:" followed by the question, then STOP.

${headlessNote()}${appPort ? `\n\n${appPortNote(appPort, appBaseUrl)}` : ''}${designGrounding ? `\n\n${designGrounding}` : ''}`;
}

function headlessNote(): string {
  return `## Headless e2e (factory-managed run)
FACTORY_HEADLESS=1 and PLAYWRIGHT_HEADLESS=1 are set in your environment — this
is an unattended run and must never open a visible browser window. Any e2e or
browser-runner config you scaffold or edit (Playwright, Cypress, etc.) must be
headless by default: keep \`headless: true\` (or omit it — headless is
Playwright's default) and never bake \`--headed\`, \`--ui\`, or \`cypress open\`
into package.json test scripts. Headed mode is a human's explicit local
opt-in, not a config default.`;
}

function appPortNote(appPort: number, appBaseUrl?: string): string {
  const baseUrlSentence = appBaseUrl
    ? `This lane owns port ${appPort}; its stable base URL is ${appBaseUrl} (via the factory proxy).`
    : `This lane owns port ${appPort} (base URL http://127.0.0.1:${appPort}).`;
  return `## Assigned app port
${baseUrlSentence} PORT and
FACTORY_APP_PORT are set in your environment. Any dev server, preview, or e2e
config must read process.env.PORT — never hardcode 3000 — and must use a strict
port (Vite: --strictPort; Next.js: -p ${appPort}) so a port mismatch fails loudly
instead of silently auto-incrementing.`;
}

function compactForLocalModel(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 6000) return trimmed;
  return `${trimmed.slice(0, 5600)}\n\n[truncated for local model: keep the implementation minimal and inspect files as needed]`;
}
