// src/phases/plan.ts — PLAN phase: boss model reads issue, explores repo, freezes spec, picks route

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import matter from 'gray-matter';
import { ModelRouter } from '../router/index.js';
import { ConstitutionLoader } from '../constitutions/index.js';
import { escalationLine, isEscalation } from '../utils/index.js';
import type { Octokit } from '@octokit/rest';

export interface PlanResult {
  ok: boolean;
  route: 'codex' | 'claude';
  specPath: string;
  model: string;
  escalate?: string;
}

export interface PlanPromptOpts {
  issue: number;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  constitutionCtx: string;
  product?: string;
}

export function buildPlanPrompt(opts: PlanPromptOpts): string {
  const { issue, issueTitle, issueBody, specPath, constitutionCtx, product } = opts;

  return `You are the PLAN phase of a multi-agent software factory for issue #${issue}.
Do NOT implement anything. You are already inside the isolated worktree (cwd).

${constitutionCtx}

## Issue #${issue}: ${issueTitle}

${issueBody}

Steps:
1. Read the issue above fully. Read CLAUDE.md / CONTEXT.md / docs/adr/ if present.
2. Explore the codebase (read/search only) enough to name the exact files, functions,
   and existing patterns/tests this issue touches, and any edge cases.
3. Decide the build route:
   - route: codex — when the implementation from a frozen spec is bounded and mechanical
     (known-repro fixes, well-scoped features, refactors, test writing, CI/tooling)
   - route: claude — when the work needs UX, design, or architecture judgment; naming/API
     design calls; is a tiny diff (<20 lines); or needs session tools
   Default to route: claude when genuinely unsure.
${product ? '4. The constitution above defines the standards for this product. Your spec MUST satisfy every standard.' : '4. No constitution loaded — use your best judgment.'}

Write EXACTLY ONE file, at ${specPath}, in this shape:
---
route: codex
---
# Spec: ${issueTitle} (#${issue})
## Goal
<what and why, one paragraph>
## Files / approach
<exact files, functions, and the concrete implementation plan — detailed enough
that a cheap worker model could build it without re-reading the issue>
## Tests
<what to add or change, and the exact command that proves it passes>
${product ? `## Constitution compliance\nFor each standard in the constitution, note how the plan satisfies it.` : '## Constitution compliance\nN/A — no constitution'}
## Non-goals
<explicitly out of scope, from the issue>

(Replace 'codex' in the frontmatter with 'claude' if that's the route you chose.)
Do not run tests, do not write or edit any other file, do not touch git.
If the issue is genuinely too vague to plan without a product decision only a human
can make, print a line starting exactly with "ESCALATE:" followed by the question,
and do NOT write ${specPath}.`;
}

export async function planPhase(
  opts: {
    issue: number;
    repo: string;
    worktree: string;
    specPath: string;
    product?: string;
    router: ModelRouter;
    constitutionLoader: ConstitutionLoader;
    octokit: Octokit;
    log: (type: string, msg: string) => void;
    timeoutSeconds?: number;
  },
): Promise<PlanResult> {
  const { issue, repo, worktree, specPath, product, router, constitutionLoader, octokit, log, timeoutSeconds } = opts;

  // Get issue details
  const [owner, repoName] = repo.split('/');
  const { data: issueData } = await octokit.rest.issues.get({ owner, repo: repoName, issue_number: issue });
  const issueTitle = issueData.title;
  const issueBody = issueData.body ?? '';

  // Build constitution context
  const constitutionCtx = product ? constitutionLoader.buildContext(product) : '';

  const prompt = buildPlanPrompt({ issue, issueTitle, issueBody, specPath, constitutionCtx, product });

  log('plan', `Starting plan phase`);

  const result = await router.run('plan', prompt, {
    worktree,
    timeout: timeoutSeconds ?? 1800,
    onLog: (msg) => log('router', msg),
  });

  // Check for escalation
  if (isEscalation(result.output)) {
    const escalateLine = escalationLine(result.output);
    log('escalate', escalateLine ?? 'plan escalated');
    return { ok: false, route: 'claude', specPath, model: result.model, escalate: escalateLine };
  }

  // Check spec file was created
  if (!existsSync(specPath)) {
    // The Claude output might BE the spec content
    await writeFile(specPath, result.output);
  }

  // Read route from spec frontmatter
  const specContent = await readFile(specPath, 'utf-8');
  let route: 'codex' | 'claude' = 'claude';
  try {
    const rawRoute = matter(specContent).data.route;
    if (rawRoute === 'codex' || rawRoute === 'claude') route = rawRoute;
  } catch {
    // malformed frontmatter -> keep default 'claude'
  }

  log('plan', `Plan complete with model ${result.model}, route: ${route}`);

  return { ok: true, route, specPath, model: result.model };
}
