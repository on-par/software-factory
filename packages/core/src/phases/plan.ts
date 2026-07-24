// src/phases/plan.ts — PLAN phase: boss model reads issue, explores repo, freezes spec, picks route

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Octokit } from '@octokit/rest';
import matter from 'gray-matter';

import type { ApprovalGate } from '../approvals/index.js';
import { PLAN_SPEC_PREVIEW_BYTES } from '../approvals/index.js';
import { buildConstitutionContext } from '../constitutions/index.js';
import { designArtifactPaths, parseDesignArtifact, renderDesignArtifact } from '../design/index.js';
import { scoreIssueReadiness } from '../readiness/index.js';
import type { ModelRouter } from '../router/index.js';
import { failoversFrom } from '../router/index.js';
import { applySteering, type ConsumedSteering, describeSteering } from '../steering/index.js';
import type { Constitution, DesignArtifact, FailoverReason, ReadinessInfo } from '../types/index.js';
import { codexDisabled, escalationLine, isEscalation } from '../utils/index.js';

export interface PlanResult {
  ok: boolean;
  route: 'codex' | 'claude';
  specPath: string;
  model: string;
  escalate?: string;
  designArtifact: DesignArtifact | null;
}

export interface PlanPromptOpts {
  issue: number;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  constitutionCtx: string;
}

export function buildPlanPrompt(opts: PlanPromptOpts): string {
  const { issue, issueTitle, issueBody, specPath, constitutionCtx } = opts;

  return `You are the PLAN phase of a multi-agent software factory for issue #${issue}.
Do NOT implement anything. You are already inside the isolated worktree (cwd).

${constitutionCtx}

## Issue #${issue}: ${issueTitle}

${issueBody}

Steps:
1. Read the issue above fully. Read CONTEXT.md / docs/adr/ if present. (Any
   CLAUDE.md/AGENTS.md standards are already included above — do not re-read them.)
2. Explore the codebase (read/search only) enough to name the exact files, functions,
   and existing patterns/tests this issue touches, and any edge cases.
3. Decide the build route:
   - route: codex — when the implementation from a frozen spec is bounded and mechanical
     (known-repro fixes, well-scoped features, refactors, test writing, CI/tooling)
   - route: claude — when the work needs UX, design, or architecture judgment; naming/API
     design calls; is a tiny diff (<20 lines); or needs session tools
   Default to route: claude when genuinely unsure.
${constitutionCtx ? '4. The constitution above defines the standards for this product. Your spec MUST satisfy every standard.' : '4. No constitution loaded — use your best judgment.'}

Write EXACTLY ONE file, at ${specPath}, in this shape:
---
route: codex
design:
  restatedProblem: >-
    <one paragraph, the problem in your own words — if this is wrong, stop>
  approach:
    chosen: <the chosen approach, briefly>
    rejected:
      - option: <rejected alternative>
        reason: <why>
  interfacesTouched:
    - <file / exported function / type added or changed>
  behaviorContract:
    - <what is true after this change that was not true before>
  verificationPlan:
    - command: <exact command>
      passWhen: <what a pass looks like>
  riskBlastRadius: <what breaks if this is wrong>
  openQuestions: []   # anything you could not resolve; empty list if none
---
# Spec: ${issueTitle} (#${issue})
## Goal
<what and why, one paragraph>
## Files / approach
<exact files, functions, and the concrete implementation plan — detailed enough
that a cheap worker model could build it without re-reading the issue>
## Tests
<what to add or change, and the exact command that proves it passes>
${constitutionCtx ? `## Constitution compliance\nFor each standard in the constitution, note how the plan satisfies it.` : '## Constitution compliance\nN/A — no constitution'}
## Non-goals
<explicitly out of scope, from the issue>

(Replace 'codex' in the frontmatter with 'claude' if that's the route you chose.)
The design: block is machine-validated — keys must match exactly as shown.
Do not run tests, do not write or edit any other file, do not touch git.
If the issue is genuinely too vague to plan without a product decision only a human
can make, print a line starting exactly with "ESCALATE:" followed by the question,
and do NOT write ${specPath}.`;
}

export async function planPhase(opts: {
  issue: number;
  repo: string;
  worktree: string;
  specPath: string;
  constitution: Constitution | null;
  router: ModelRouter;
  octokit: Octokit;
  log: (
    type: string,
    msg: string,
    extra?: {
      failoverReason?: FailoverReason;
      model?: string;
      tokens?: { input: number; output: number };
      readiness?: ReadinessInfo;
    },
  ) => void;
  timeoutSeconds?: number;
  modelOverride?: string;
  branch?: string;
  approvalGate?: ApprovalGate;
  drainSteering?: () => ConsumedSteering;
  maxReplans?: number;
  codexDisabled?: boolean;
}): Promise<PlanResult> {
  const {
    issue,
    repo,
    worktree,
    specPath,
    constitution,
    router,
    octokit,
    log,
    timeoutSeconds,
    modelOverride,
    branch,
    approvalGate,
    drainSteering,
  } = opts;
  const maxReplans = opts.maxReplans ?? 3;
  const isCodexDisabled = opts.codexDisabled ?? codexDisabled();

  // Get issue details
  const [owner, repoName] = repo.split('/');
  const { data: issueData } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
  const issueTitle = issueData.title;
  const issueBody = issueData.body ?? '';

  const constitutionCtx = buildConstitutionContext(constitution);

  log('plan', `Starting plan phase`);

  const readiness = scoreIssueReadiness({ title: issueTitle, body: issueBody });
  log(
    'readiness',
    `issue readiness ${Math.round(readiness.score * 100)}% (${readiness.template})${readiness.pass ? '' : ` — missing: ${readiness.missing.join(', ')}`}`,
    { readiness },
  );

  let steering: ConsumedSteering | undefined;
  let replans = 0;

  while (true) {
    const prompt = applySteering(
      buildPlanPrompt({ issue, issueTitle, issueBody, specPath, constitutionCtx }),
      steering,
    );

    if (replans > 0) {
      log('plan', `Re-planning after operator redirect (attempt ${replans + 1})`);
    }
    await archiveExistingSpec(specPath, log);

    const result = await router.run('plan', prompt, {
      worktree,
      timeoutSeconds: timeoutSeconds ?? 1800,
      modelOverride,
      onLog: (msg) => log('router', msg),
    });

    for (const f of failoversFrom(result.attempts)) {
      log('failover', `${f.model} failed (${f.reason})${f.detail ? `: ${f.detail}` : ''} — failed over`, {
        failoverReason: f.reason,
      });
    }

    // Check for escalation
    if (isEscalation(result.output)) {
      const escalateLine = escalationLine(result.output);
      log('escalate', escalateLine ?? 'plan escalated');
      return {
        ok: false,
        route: 'claude',
        specPath,
        model: result.model,
        escalate: escalateLine,
        designArtifact: null,
      };
    }

    // Check spec file was created. If the model is chat-only, the output is the
    // spec content; if it has file tools, it may have written specPath directly.
    if (!existsSync(specPath)) {
      await writeFile(specPath, result.output);
    }

    // Read route from spec frontmatter
    const specContent = await readFile(specPath, 'utf-8');
    let route: 'codex' | 'claude' = 'claude';
    let parsedSpec: ReturnType<typeof matter> | undefined;
    try {
      parsedSpec = matter(specContent);
      const rawRoute = parsedSpec.data.route;
      const trimmedRoute = typeof rawRoute === 'string' ? rawRoute.trim() : rawRoute;
      if (trimmedRoute === 'codex' || trimmedRoute === 'claude') route = trimmedRoute;
    } catch {
      // malformed frontmatter -> keep default 'claude'
    }

    if (process.env.FACTORY_LOCAL_ONLY === '1' && route !== 'codex') {
      log('warn', 'local-only mode requires a local Codex harness — forcing route to codex');
      route = 'codex';
      if (parsedSpec) {
        await writeFile(specPath, matter.stringify(parsedSpec.content, { ...parsedSpec.data, route: 'codex' }));
      }
    }

    if (route === 'codex' && isCodexDisabled) {
      log('warn', 'codex unavailable — falling back to claude');
      route = 'claude';
      // Keep the persisted spec's frontmatter in sync with the actual route,
      // since it's the frozen artifact downstream consumers (eval scoring, PR review) read.
      if (parsedSpec) {
        await writeFile(specPath, matter.stringify(parsedSpec.content, { ...parsedSpec.data, route: 'claude' }));
      }
    }

    const { artifact: designArtifact, errors: designErrors } = parseDesignArtifact(parsedSpec?.data ?? {});
    if (designArtifact) {
      const paths = designArtifactPaths(specPath);
      await writeFile(paths.json, JSON.stringify(designArtifact, null, 2));
      await writeFile(paths.markdown, renderDesignArtifact(designArtifact, issue));
      log(
        'design_artifact_emitted',
        `design artifact validated and written (open questions: ${designArtifact.openQuestions.length})`,
      );
      if (designArtifact.openQuestions.length > 0) {
        const summary = designArtifact.openQuestions.join('; ');
        const truncated = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
        log('design_open_questions', `plan has ${designArtifact.openQuestions.length} open question(s): ${truncated}`);
      }
    } else {
      log('design_artifact_invalid', `spec frontmatter has no valid design artifact: ${designErrors.join('; ')}`);
    }

    log('plan', `Plan complete with model ${result.model}, route: ${route}`, { model: result.model });

    const planResult: PlanResult = { ok: true, route, specPath, model: result.model, designArtifact };

    if (!approvalGate) return planResult;

    const specForApproval = await readFile(specPath, 'utf-8');
    const specPreview =
      specForApproval.length > PLAN_SPEC_PREVIEW_BYTES
        ? specForApproval.slice(0, PLAN_SPEC_PREVIEW_BYTES)
        : specForApproval;

    log('plan_approval_requested', `awaiting plan approval for issue #${issue} (route: ${route})`);
    const response = await approvalGate({
      issue,
      branch: branch ?? '',
      worktree,
      diffStat: '',
      kind: 'plan',
      specPreview,
    });

    if (response.approved) {
      log('plan_approval_granted', `plan approved for issue #${issue}`);
      return planResult;
    }

    const redirect = drainSteering?.();
    if (redirect && redirect.messages.length > 0) {
      if (replans >= maxReplans) {
        const reason = `plan re-plan limit exceeded (${maxReplans} redirects)`;
        log('plan_rejected', reason);
        return { ok: false, route, specPath, model: result.model, escalate: reason, designArtifact: null };
      }
      replans++;
      steering = redirect;
      log('plan_redirect', describeSteering(redirect));
      continue; // re-plan with the redirect applied to the prompt
    }

    const reason = response.reason ?? 'plan rejected by operator';
    log('plan_rejected', reason);
    return {
      ok: false,
      route,
      specPath,
      model: result.model,
      escalate: `plan rejected: ${reason}`,
      designArtifact: null,
    };
  }
}

async function archiveExistingSpec(specPath: string, log: (type: string, msg: string) => void): Promise<void> {
  if (!existsSync(specPath)) return;

  const archiveDir = join(dirname(specPath), '.archive');
  const timestamp = Date.now();
  const archivedPath = join(archiveDir, `${timestamp}-${specPath.split('/').pop() ?? 'spec.md'}`);
  await mkdir(archiveDir, { recursive: true });
  await rename(specPath, archivedPath);
  log('plan', `Archived existing spec before planning: ${archivedPath}`);

  const { json, markdown } = designArtifactPaths(specPath);
  for (const designPath of [json, markdown]) {
    if (!existsSync(designPath)) continue;
    const archivedDesignPath = join(archiveDir, `${timestamp}-${designPath.split('/').pop() ?? 'spec.design'}`);
    await rename(designPath, archivedDesignPath);
  }
}
