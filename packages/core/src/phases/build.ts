// src/phases/build.ts — BUILD phase: worker model implements the frozen spec

import { readFile } from 'node:fs/promises';
import { ModelRouter } from '../router/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';

export interface BuildResult {
  ok: boolean;
  model: string;
  escalate?: string;
}

export async function buildPhase(
  opts: {
    issue: number;
    repo: string;
    worktree: string;
    specPath: string;
    branch: string;
    product?: string;
    route: 'codex' | 'claude';
    router: ModelRouter;
    constitutionLoader: ConstitutionLoader;
    log: (type: string, msg: string) => void;
    timeoutSeconds?: number;
  },
): Promise<BuildResult> {
  const { issue, repo, worktree, specPath, branch, product, route, router, constitutionLoader, log, timeoutSeconds } = opts;

  const constitutionCtx = product ? constitutionLoader.buildContext(product) : '';
  const spec = await readFile(specPath, 'utf-8').catch(() => '');

  let prompt: string;
  let taskType: 'build_codex' | 'build_claude';

  if (route === 'codex') {
    taskType = 'build_codex';
    prompt = `Implement issue #${issue} exactly per the frozen spec at ${specPath} in this repository.
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
message explaining what's blocked, and stop there.`;
  } else {
    taskType = 'build_claude';
    prompt = `/ship-it ${issue} — Run fully autonomously in headless mode, BUILD phase.
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
(2) open PR exists with 'Closes #${issue}' in its body, (3) CI is green, (4) PR ready.

If and ONLY IF you hit something genuinely ambiguous, print a line starting exactly
with "ESCALATE:" followed by the question, then STOP.`;
  }

  log('build', `Starting build phase (route: ${route})`);

  const result = await router.run(taskType, prompt, {
    worktree,
    timeout: timeoutSeconds ?? 7200,
    onLog: (msg) => log('router', msg),
  });

  if (isEscalation(result.output)) {
    const escalateLine = escalationLine(result.output);
    log('escalate', escalateLine ?? 'build escalated');
    return { ok: false, model: result.model, escalate: escalateLine };
  }

  log('build', `Build complete with model ${result.model}`);
  return { ok: true, model: result.model };
}
