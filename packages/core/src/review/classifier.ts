// packages/core/src/review/classifier.ts — shadow PR classifier model verdict with cited receipts (#1725, ADR-0121). Never throws.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { createFsReader } from '@on-par/repo-context';
import { z } from 'zod';

import { adrLabel, readAdrContext, renderAdrConstraints, type AdrContext } from '../adr/index.js';
import { collectDesignDiff, MAX_DIFF_CHARS, MAX_SPEC_CHARS } from '../checkers/design-smells.js';
import { readDesignArtifact, renderDesignGrounding } from '../design/index.js';
import type { ModelRouter } from '../router/index.js';
import { extractJsonObjects } from '../utils/json.js';
import type { ReviewClass, ReviewFloorFiredRule, ReviewFloorRuleSet } from './floor.js';

/** Bump in the same change as any edit to buildClassifierPrompt's wording or inputs. */
export const CLASSIFIER_PROMPT_VERSION = 'classify-pr/v1';
export const CLASSIFIER_TIMEOUT_SECONDS = 600;
const MAX_ISSUE_BODY_CHARS = 8_000;
/** `path:line`, `path:line-line` or `ADR-NNNN`. */
const CITATION_PATTERN = /^(?:[^\s:]+:\d+(?:-\d+)?|ADR-\d{4})$/;

export const PrClassifierClaimSchema = z.object({
  text: z.string().min(1),
  citation: z
    .string()
    .nullish()
    .transform((v) => (v ?? '').trim()),
});

export const PrClassifierOutputSchema = z.object({
  class: z.enum(['A', 'B', 'C']),
  claims: z
    .array(z.unknown())
    .nullish()
    .transform((v) => v ?? []),
  notInspected: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

export interface PrClassifierClaim {
  text: string;
  /** '' when the model gave none. */
  citation: string;
}

export interface PrShadowInput {
  worktree: string;
  fallbackBaseRef?: string;
  issueTitle: string;
  issueBody: string;
  specPath: string;
  floor: ReviewClass | null;
  floorRules: ReviewFloorFiredRule[];
  rules: ReviewFloorRuleSet;
  modelPin?: string;
  router: ModelRouter;
}

/** The only facts the classifier may see (ADR-0121): diff, issue title/body, frozen spec and
 *  design, the floor result and ranked ADRs. There is deliberately no field for the PR body,
 *  commit messages or build/rework transcripts. */
export interface ClassifierPromptInput {
  diff: string;
  truncated: boolean;
  issueTitle: string;
  issueBody: string;
  specText: string;
  designGrounding: string;
  adrCtx: string;
  floor: ReviewClass | null;
  floorRules: ReviewFloorFiredRule[];
}

export interface PrShadowVerdict {
  modelClass: ReviewClass | null;
  floorClass: ReviewClass | null;
  /** Always the floor class: the shadow verdict has no effect. */
  finalClass: ReviewClass | null;
  model: string | null;
  promptVersion: string;
  policyVersion: string;
  diffSha: string | null;
  adrIds: string[];
  costUsd: number | null;
  claims: PrClassifierClaim[];
  unsupportedClaims: PrClassifierClaim[];
  notInspected: string[];
  droppedClaims: number;
  reason?: string;
}

export type PrClassificationRecord = PrShadowVerdict;

export function toClassificationRecord(verdict: PrShadowVerdict): PrClassificationRecord {
  return { ...verdict };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function classifierPolicyVersion(rules: ReviewFloorRuleSet): string {
  return `floor-${sha256(JSON.stringify(rules)).slice(0, 12)}`;
}

export function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('diff --git a/')) continue;
    const at = line.lastIndexOf(' b/');
    if (at > 0) paths.add(line.slice(at + 3));
  }
  return [...paths].sort();
}

export function buildClassifierPrompt(input: ClassifierPromptInput): string {
  const lines: string[] = [
    'You are a PR REVIEW ROUTER. Given the facts below, you propose a review class for this pull request; you never approve it.',
    '',
    'Classes:',
    '- A: low-risk, mechanical or well-bounded change; a human skim is enough.',
    '- B: ordinary behavior change; needs a normal human review.',
    '- C: high-risk (security, data, public API, build/CI, policy, prompts) or large/cross-cutting; needs careful human review.',
    'The deterministic floor below is a minimum: you cannot propose a class lower than it.',
    '',
    '## Issue',
    input.issueTitle,
    '',
    input.issueBody.slice(0, MAX_ISSUE_BODY_CHARS),
    '',
    '## Deterministic floor',
    input.floor === null ? 'Floor class: unavailable' : `Floor class: ${input.floor}`,
  ];
  if (input.floorRules.length === 0) {
    lines.push('Fired rules: none');
  } else {
    for (const rule of input.floorRules) {
      lines.push(`- ${rule.id} (${rule.class}): ${rule.paths.join(', ')}`);
    }
  }
  lines.push('');
  if (input.adrCtx) lines.push(input.adrCtx, '');
  if (input.designGrounding) lines.push('## Frozen design', input.designGrounding, '');
  lines.push('## Frozen spec', input.specText.slice(0, MAX_SPEC_CHARS), '', '## Diff', '```diff', input.diff, '```');
  if (input.truncated) {
    lines.push('', `(diff truncated at ${MAX_DIFF_CHARS} characters — judge only what you can see)`);
  }
  lines.push(
    '',
    'Rules:',
    '- Every claim must cite `path:line` from the diff, or an `ADR-NNNN`. Claims without a citation are discarded as unsupported.',
    '- List anything you did not inspect in `notInspected`.',
    '',
    'Reply with ONLY one JSON object, no prose:',
    '{"class":"A|B|C","claims":[{"text":"…","citation":"src/x.ts:42"}],"notInspected":["…"]}',
  );
  return lines.join('\n');
}

export type ParsedClassifierOutput =
  | {
      ok: true;
      class: ReviewClass;
      claims: PrClassifierClaim[];
      unsupported: PrClassifierClaim[];
      notInspected: string[];
      droppedClaims: number;
    }
  | { ok: false; reason: string };

export function parseClassifierOutput(output: string): ParsedClassifierOutput {
  const candidate = extractJsonObjects(output).find(
    (c) => typeof c.value === 'object' && c.value !== null && 'class' in c.value,
  );
  if (!candidate) {
    return { ok: false, reason: `classifier produced no JSON object: ${output.slice(0, 200)}` };
  }
  const envelope = PrClassifierOutputSchema.safeParse(candidate.value);
  if (!envelope.success) {
    return {
      ok: false,
      reason: `classifier returned malformed or unknown-class verdict: ${envelope.error.message.slice(0, 200)}`,
    };
  }
  const claims: PrClassifierClaim[] = [];
  const unsupported: PrClassifierClaim[] = [];
  let droppedClaims = 0;
  for (const raw of envelope.data.claims) {
    const parsed = PrClassifierClaimSchema.safeParse(raw);
    if (!parsed.success) {
      droppedClaims++;
      continue;
    }
    (CITATION_PATTERN.test(parsed.data.citation) ? claims : unsupported).push(parsed.data);
  }
  return {
    ok: true,
    class: envelope.data.class,
    claims,
    unsupported,
    notInspected: envelope.data.notInspected,
    droppedClaims,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function classifyPrShadow(
  input: PrShadowInput,
  deps?: {
    collectDiff?: typeof collectDesignDiff;
    readFile?: (path: string) => Promise<string>;
    readAdrs?: (worktree: string, changedPaths: readonly string[]) => Promise<AdrContext>;
  },
): Promise<PrShadowVerdict> {
  const base: PrShadowVerdict = {
    modelClass: null,
    floorClass: input.floor,
    finalClass: input.floor,
    model: null,
    promptVersion: CLASSIFIER_PROMPT_VERSION,
    policyVersion: 'floor-unknown',
    diffSha: null,
    adrIds: [],
    costUsd: null,
    claims: [],
    unsupportedClaims: [],
    notInspected: [],
    droppedClaims: 0,
  };
  try {
    base.policyVersion = classifierPolicyVersion(input.rules);

    const diff = await (deps?.collectDiff ?? collectDesignDiff)(input.worktree, undefined, {
      fallbackBaseRef: input.fallbackBaseRef,
    });
    if (diff.skipReason) return { ...base, reason: `no diff: ${diff.skipReason}` };
    if (diff.text === '') return { ...base, reason: 'no diff to classify' };
    base.diffSha = sha256(diff.text);

    const specText = await (deps?.readFile ?? ((p: string) => readFile(p, 'utf-8')))(input.specPath).catch(
      () => '(no spec)',
    );

    let designGrounding = '';
    try {
      const artifact = await readDesignArtifact(input.specPath);
      designGrounding = artifact ? renderDesignGrounding(artifact) : '';
    } catch {
      designGrounding = '';
    }

    let adrCtx = '';
    try {
      const readAdrs =
        deps?.readAdrs ??
        ((w: string, p: readonly string[]) => readAdrContext(createFsReader({ root: w }), { changedPaths: p }));
      const ctx = await readAdrs(input.worktree, changedPathsFromDiff(diff.text));
      base.adrIds = ctx.active.map(adrLabel);
      adrCtx = renderAdrConstraints(ctx);
    } catch {
      base.adrIds = [];
      adrCtx = '';
    }

    const prompt = buildClassifierPrompt({
      diff: diff.text,
      truncated: diff.truncated,
      issueTitle: input.issueTitle,
      issueBody: input.issueBody,
      specText,
      designGrounding,
      adrCtx,
      floor: input.floor,
      floorRules: input.floorRules,
    });

    let result: Awaited<ReturnType<ModelRouter['run']>>;
    try {
      result = await input.router.run('classify_pr', prompt, {
        worktree: input.worktree,
        timeoutSeconds: CLASSIFIER_TIMEOUT_SECONDS,
        ...(input.modelPin ? { modelOverride: input.modelPin } : {}),
      });
    } catch (err) {
      return { ...base, reason: `classifier call failed: ${errorMessage(err).slice(0, 300)}` };
    }

    // An estimate from prompt/output length; null when the model is unpriced (ADR-0122).
    let costUsd: number | null = null;
    try {
      costUsd =
        input.router.registryRef.estimateCost(
          result.model,
          Math.ceil(prompt.length / 4),
          Math.ceil(result.output.length / 4),
        ) ?? null;
    } catch {
      costUsd = null;
    }

    const parsed = parseClassifierOutput(result.output);
    if (!parsed.ok) return { ...base, model: result.model, costUsd, reason: parsed.reason };
    return {
      ...base,
      modelClass: parsed.class,
      model: result.model,
      costUsd,
      claims: parsed.claims,
      unsupportedClaims: parsed.unsupported,
      notInspected: parsed.notInspected,
      droppedClaims: parsed.droppedClaims,
    };
  } catch (err) {
    return { ...base, reason: `classifier error: ${errorMessage(err).slice(0, 300)}` };
  }
}
