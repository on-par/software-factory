// src/phases/build.ts — BUILD phase: worker model implements the frozen spec

import { readFile } from 'node:fs/promises';

import { buildConstitutionContext } from '../constitutions/index.js';
import { leaseEnv } from '../environment/index.js';
import type { ModelRouter, RouterResult } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { applySteering, type ConsumedSteering } from '../steering/index.js';
import type { Constitution, FailoverReason } from '../types/index.js';
import { codexDisabled, escalationLine, isEscalation } from '../utils/index.js';

export interface BuildResult {
  ok: boolean;
  model: string;
  escalate?: string;
}

export async function buildPhase(opts: {
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  branch: string;
  constitution: Constitution | null;
  route: 'codex' | 'claude';
  router: ModelRouter;
  log: (type: string, msg: string, extra?: { failoverReason?: FailoverReason }) => void;
  timeoutSeconds?: number;
  skipCI?: boolean;
  modelOverride?: string;
  sandbox?: SandboxPolicy;
  steering?: ConsumedSteering;
  appPort?: number;
  codexDisabled?: boolean;
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
    modelOverride,
    sandbox,
    steering,
    appPort,
  } = opts;
  let route = opts.route;

  const constitutionCtx = buildConstitutionContext(constitution);
  const spec = await readFile(specPath, 'utf-8').catch(() => '');
  const localOnly = process.env.FACTORY_LOCAL_ONLY === '1';
  const isCodexDisabled = opts.codexDisabled ?? codexDisabled();

  let prompt: string;
  let taskType: 'build_codex' | 'build_claude';

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
      : `Implement issue #${issue} exactly per the frozen spec at ${specPath} in this repository.
Read the full spec before writing any code — it is the approved plan; do not deviate.

${constitutionCtx}

## Spec
${spec}

Match surrounding code style and idioms. Add or update the tests described in the
spec's Tests section and actually run them — report the exact command and its output.
If the repo has a fast verify path (scripts/verify.sh, npm test), run it and fix
failures before finishing.

When everything passes, create exactly ONE git commit with a clear, conventional
message describing the change. Do NOT push, do NOT open a pull request, do NOT
merge — a separate checker and ship phase handles that next.

Stay strictly within the spec's scope: no unrelated refactors, no drive-by changes.
If you get genuinely stuck, commit whatever safely builds/passes so far with a
message explaining what's blocked, and stop there.

Keep sub-agent/parallel-task usage modest: only fan out when a piece of work is
genuinely independent and parallelizable. Prefer doing the work directly over
spawning sub-agents for a single small issue — this keeps token usage efficient.${appPort ? `\n\n${appPortNote(appPort)}` : ''}`;
  } else {
    taskType = 'build_claude';
    prompt = buildClaudePrompt({ issue, branch, specPath, constitutionCtx, skipCI, appPort });
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
    onSandboxEvent: (type: string, detail: string) => log(type, detail),
    onLog: (msg: string) => log('router', msg),
    ...(appPort ? { env: leaseEnv(appPort) } : {}),
  };

  let result: RouterResult;
  try {
    result = await router.run(taskType, prompt, runOpts);
  } catch (err) {
    const reason = (err as { reason?: FailoverReason }).reason;
    const attempts = (err as { attempts?: RouterResult['attempts'] }).attempts;
    const quota = reason === 'usage_cap' || reason === 'rate_limit';
    // Only swap when we actually ran the codex route and it was exhausted on a
    // quota reason. The router only throws after trying every eligible codex
    // worker, so reaching here already means "no Codex-harness worker remains".
    if (taskType !== 'build_codex' || !quota) throw err;
    const toModel = router.resolveAll('build_claude')[0];
    if (!toModel) throw err; // no claude fallback available — park as today
    const fromModel = attempts?.at(-1)?.model ?? 'unknown';
    log(
      'worker_failover',
      `Codex build workers exhausted (${reason}) — continuing on claude: ` +
        `from_model=${fromModel} to_model=${toModel} ` +
        `from_route=build_codex to_route=build_claude reason=${reason}`,
      { failoverReason: reason },
    );
    route = 'claude';
    taskType = 'build_claude';
    const claudePrompt = applySteering(
      buildClaudePrompt({ issue, branch, specPath, constitutionCtx, skipCI, appPort }),
      steering,
    );
    result = await router.run('build_claude', claudePrompt, runOpts);
  }

  for (const f of failoversFrom(result.attempts)) {
    log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
      failoverReason: f.reason,
    });
  }

  if (isEscalation(result.output)) {
    const escalateLine = escalationLine(result.output);
    log('escalate', escalateLine ?? 'build escalated');
    return { ok: false, model: result.model, escalate: escalateLine };
  }

  log('build', `Build complete with model ${result.model}`);
  return { ok: true, model: result.model };
}

function buildClaudePrompt(opts: {
  issue: number;
  branch: string;
  specPath: string;
  constitutionCtx: string;
  skipCI?: boolean;
  appPort?: number;
}): string {
  const { issue, branch, specPath, constitutionCtx, skipCI, appPort } = opts;
  return `/ship-it ${issue} — Run fully autonomously in headless mode, BUILD phase.
You are ALREADY inside the isolated git worktree for issue ${issue} (branch ${branch},
cwd is this worktree), so SKIP ship-it's worktree-creation step.

${constitutionCtx}

A frozen, already-approved spec exists at ${specPath} (written by a separate planning pass)
— read it and treat it as your go/no-go plan; do NOT re-derive your own plan from the
issue or block on any plan gate. Auto-fix only high-confidence review findings; for
uncertain findings apply the conservative default and note the deferral in the PR body.
Never pause for permission or input — nobody is watching this session.

Stop at a green, ready-for-review PR — do NOT merge (the factory handles merging).
CRITICAL: your session terminates the moment you end your turn, so NEVER end your
turn after an intermediate step. Before ending: (1) branch ${branch} is pushed,
(2) open PR exists with 'Closes #${issue}' in its body, ${skipCI ? '(3) local verify passes (CI is intentionally skipped — do NOT block on GitHub Actions CI, do NOT escalate if CI cannot run), (4) PR ready.' : '(3) CI is green, (4) PR ready.'}

If and ONLY IF you hit something genuinely ambiguous, print a line starting exactly
with "ESCALATE:" followed by the question, then STOP.${appPort ? `\n\n${appPortNote(appPort)}` : ''}`;
}

function appPortNote(appPort: number): string {
  return `## Assigned app port
This lane owns port ${appPort} (base URL http://127.0.0.1:${appPort}); PORT and
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
