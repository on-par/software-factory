// src/checkers/design-smells.ts — CHECK-phase program-design smell critic over the real diff (#483).

import { readFile } from 'node:fs/promises';

import { createFsReader } from '@on-par/repo-context';
import { z } from 'zod';

import { readAdrContext, renderAdrConstraints } from '../adr/index.js';
import { readDesignArtifact, renderDesignGrounding } from '../design/index.js';
import type { ModelRouter } from '../router/index.js';
import type { CheckerOutput } from '../types/index.js';
import { runCommand } from '../utils/command-runner.js';
import { extractJsonObjects } from '../utils/json.js';
import type { CheckerContext } from './index.js';

export const DESIGN_SMELLS_CHECKER = 'design_smells';

/** Smell taxonomy from #483 — the four maintainability failures binary gates cannot see. */
export const SMELL_KINDS = ['cast-to-pass', 'swallowed-error', 'shotgun-surgery', 'boundary-violation'] as const;

/** Base refs tried in order; the first that resolves is the merge-base target. */
export const BASE_REF_CANDIDATES = ['origin/main', 'origin/master'] as const;

/** Generated/vendored paths a design critic must not grade. */
export const DIFF_EXCLUDES = [
  ':!package-lock.json',
  ':!**/package-lock.json',
  ':!*.lock',
  ':!dist/**',
  ':!**/dist/**',
  ':!coverage/**',
  ':!**/*.snap',
] as const;

/** Hard cap on diff characters injected into the critic prompt. */
export const MAX_DIFF_CHARS = 120_000;
/** Cap on the frozen spec text injected into the critic prompt. */
export const MAX_SPEC_CHARS = 8_000;
/** Cap on the rendered detail string handed to the rework worker. */
export const MAX_SMELLS_RENDERED = 10;
const MAX_FIELD_CHARS = 240;

export const DesignSmellSchema = z.object({
  kind: z.enum(SMELL_KINDS),
  file: z.string().min(1),
  line: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((v) => v ?? undefined),
  evidence: z.string().min(1),
  suggestion: z.string().min(1),
});

/**
 * Envelope-only validation. Elements are validated one at a time in
 * `parseDesignSmellVerdict` so one malformed smell cannot discard its valid siblings (#643).
 */
export const DesignSmellVerdictSchema = z.object({
  checker: z.literal(DESIGN_SMELLS_CHECKER),
  result: z.enum(['PASS', 'FAIL']),
  smells: z
    .array(z.unknown())
    .nullish()
    .transform((v) => v ?? []),
});

export type DesignSmell = z.infer<typeof DesignSmellSchema>;

export interface DesignSmellVerdict {
  checker: typeof DESIGN_SMELLS_CHECKER;
  result: 'PASS' | 'FAIL';
  smells: DesignSmell[];
}

/** A `smells` element that failed validation: its array index and the zod issues. */
export interface RejectedSmell {
  index: number;
  errors: string[];
}

export type DiffRunner = (argv: readonly string[], cwd: string) => Promise<{ ok: boolean; stdout: string }>;

const defaultDiffRunner: DiffRunner = async (argv, cwd) => {
  const r = await runCommand(argv, { cwd, timeoutMs: 60_000 });
  return { ok: r.ok, stdout: r.stdout };
};

export interface CollectedDiff {
  /** '' when there is nothing to grade. */
  text: string;
  baseRef: string | null;
  truncated: boolean;
  /** Set when the diff could not be collected at all (not a git checkout, no base ref). */
  skipReason?: string;
}

export async function collectDesignDiff(worktree: string, run: DiffRunner = defaultDiffRunner): Promise<CollectedDiff> {
  let baseRef: string | null = null;
  for (const candidate of BASE_REF_CANDIDATES) {
    const check = await run(['git', 'rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], worktree);
    if (check.ok) {
      baseRef = candidate;
      break;
    }
  }

  if (baseRef === null) {
    return {
      text: '',
      baseRef: null,
      truncated: false,
      skipReason: 'no base ref (tried origin/main, origin/master) — not a git checkout or no remote base',
    };
  }

  const committed = await run(
    ['git', 'diff', '--unified=3', `${baseRef}...HEAD`, '--', '.', ...DIFF_EXCLUDES],
    worktree,
  );
  const uncommitted = await run(['git', 'diff', '--unified=3', 'HEAD', '--', '.', ...DIFF_EXCLUDES], worktree);

  const parts: string[] = [];
  if (committed.ok && committed.stdout.length > 0) parts.push(committed.stdout);
  if (uncommitted.ok && uncommitted.stdout.length > 0) {
    parts.push(`\n### Uncommitted changes in the worktree\n${uncommitted.stdout}`);
  }

  let text = parts.join('\n');
  let truncated = false;
  if (text.length > MAX_DIFF_CHARS) {
    text = `${text.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters]`;
    truncated = true;
  }

  return { text, baseRef, truncated };
}

/** Operators disable the critic per-run with FACTORY_DESIGN_SMELLS=0. */
export function designSmellsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FACTORY_DESIGN_SMELLS !== '0';
}

export function buildDesignSmellPrompt(input: {
  worktree: string;
  diff: string;
  truncated: boolean;
  baseRef: string;
  specText: string;
  constitutionBody: string;
  adrCtx: string;
  designGrounding: string;
}): string {
  const lines: string[] = [
    'You are a PROGRAM-DESIGN CRITIC in a software factory. Do not re-run the tests —',
    'compile/tests/lint already ran. Judge the *design* of this diff.',
    '',
    `WORKTREE: ${input.worktree}`,
    `DIFF BASE: ${input.baseRef}`,
    '',
    '## Constitution (the written standard)',
    input.constitutionBody || '(none)',
    '',
  ];

  if (input.adrCtx) {
    lines.push(input.adrCtx, '');
  }

  if (input.designGrounding) {
    lines.push(
      'The frozen PLAN design below is the intended shape of this change — files, types and',
      'signatures outside it are candidate shotgun-surgery.',
      '',
      input.designGrounding,
      '',
    );
  }

  lines.push('## Frozen spec', input.specText.slice(0, MAX_SPEC_CHARS), '', '## Diff', '```diff', input.diff, '```');
  if (input.truncated) {
    lines.push('', `(diff truncated at ${MAX_DIFF_CHARS} characters — judge only what you can see)`);
  }

  lines.push(
    '',
    '## Smell taxonomy',
    '',
    '- `cast-to-pass` — an `as`/`as any`/`any`/`@ts-expect-error`/non-null `!` introduced **only** so',
    '  a call type-checks, where the underlying type or signature should have changed instead. A cast',
    '  that narrows a genuinely-unknown external value at a trust boundary is **not** a smell.',
    '- `swallowed-error` — a `try`/`catch` (or `.catch(() => …)`) added by this diff that discards the',
    '  error and continues with a fabricated value, hiding a failure the caller needed. A catch that',
    '  logs, degrades deliberately, or converts to a typed result is **not** a smell.',
    '- `shotgun-surgery` — one logical change spread across many files/modules where a single seam',
    '  (named in the frozen design) would do; call out the seam that should have absorbed it.',
    '- `boundary-violation` — the diff crosses a boundary the constitution or an Accepted ADR fixes',
    '  (e.g. importing across a package seam that the ADR routes through a port, reaching into another',
    "  package's internals, or hard-coding config the constitution says lives in config).",
    '',
    'Every finding must cite a file that appears in the diff, and must include a concrete suggested',
    'alternative — findings without both are worthless and must be dropped.',
    '',
    'Report only smells you are confident are real; an empty `smells` array with `result: "PASS"` is',
    'the correct answer for a clean diff.',
    '',
    'Return a JSON verdict on stdout (and ONLY the JSON):',
    '{"checker":"design_smells","result":"PASS or FAIL","smells":[{"kind":"cast-to-pass","file":"src/x.ts","line":42,"evidence":"<what the diff does>","suggestion":"<the concrete alternative>"}]}',
  );

  return lines.join('\n');
}

export function parseDesignSmellVerdict(output: string): {
  verdict: DesignSmellVerdict | null;
  rejected: RejectedSmell[];
  reason?: string;
} {
  const candidates = extractJsonObjects(output);
  const verdictCandidate = candidates.find(
    (c) =>
      typeof c.value === 'object' &&
      c.value !== null &&
      !Array.isArray(c.value) &&
      'checker' in (c.value as Record<string, unknown>),
  );

  if (!verdictCandidate) {
    return { verdict: null, rejected: [], reason: `critic produced no valid JSON: ${output.slice(0, 200)}` };
  }

  const parsed = DesignSmellVerdictSchema.safeParse(verdictCandidate.value);
  if (!parsed.success) {
    return {
      verdict: null,
      rejected: [],
      reason: `critic returned a malformed verdict: ${verdictCandidate.text.slice(0, 200)}`,
    };
  }

  const smells: DesignSmell[] = [];
  const rejected: RejectedSmell[] = [];
  parsed.data.smells.forEach((entry, index) => {
    const result = DesignSmellSchema.safeParse(entry);
    if (result.success) {
      smells.push(result.data);
      return;
    }
    rejected.push({
      index,
      errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  });

  return { verdict: { checker: DESIGN_SMELLS_CHECKER, result: parsed.data.result, smells }, rejected };
}

function truncateField(text: string): string {
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

export function renderSmellDetails(smells: DesignSmell[]): string {
  const shown = smells.slice(0, MAX_SMELLS_RENDERED);
  const rendered = shown.map((s) => {
    const location = s.line !== undefined ? `${s.file}:${s.line}` : s.file;
    return `[${s.kind}] ${location} — ${truncateField(s.evidence)} → suggested: ${truncateField(s.suggestion)}`;
  });

  const more = smells.length - shown.length;
  const suffix = more > 0 ? `; (${more} more)` : '';

  return `${smells.length} program-design smell(s): ${rendered.join('; ')}${suffix}`;
}

/** Renders the dropped elements so a malformed finding is visible, not silent (#643). */
export function renderRejectedSmells(rejected: RejectedSmell[]): string {
  const shown = rejected.slice(0, MAX_SMELLS_RENDERED);
  const rendered = shown.map((r) => `[${r.index}] ${truncateField(r.errors.join(', '))}`);
  const more = rejected.length - shown.length;
  const suffix = more > 0 ? `; (${more} more)` : '';
  return `${rejected.length} malformed smell element(s) dropped: ${rendered.join('; ')}${suffix}`;
}

export async function designSmellsChecker(
  ctx: CheckerContext,
  router: ModelRouter,
  timeoutSeconds?: number,
  deps?: { collectDiff?: typeof collectDesignDiff; env?: NodeJS.ProcessEnv },
): Promise<CheckerOutput> {
  if (!designSmellsEnabled(deps?.env)) {
    return { checker: DESIGN_SMELLS_CHECKER, result: 'SKIP', details: 'disabled by FACTORY_DESIGN_SMELLS=0' };
  }

  const diff = await (deps?.collectDiff ?? collectDesignDiff)(ctx.worktree);
  if (diff.skipReason) {
    return { checker: DESIGN_SMELLS_CHECKER, result: 'SKIP', details: diff.skipReason };
  }
  if (diff.text === '') {
    return {
      checker: DESIGN_SMELLS_CHECKER,
      result: 'SKIP',
      details: `no diff against ${diff.baseRef} — nothing to critique`,
    };
  }

  const specText = await readFile(ctx.specPath, 'utf-8').catch(() => '(no spec)');

  let adrCtx = '';
  try {
    adrCtx = renderAdrConstraints(await readAdrContext(createFsReader({ root: ctx.worktree })));
  } catch {
    adrCtx = '';
  }

  let designGrounding = '';
  try {
    const artifact = await readDesignArtifact(ctx.specPath);
    designGrounding = artifact ? renderDesignGrounding(artifact) : '';
  } catch {
    designGrounding = '';
  }

  const prompt = buildDesignSmellPrompt({
    worktree: ctx.worktree,
    diff: diff.text,
    truncated: diff.truncated,
    baseRef: diff.baseRef ?? '(unknown)',
    specText: specText.slice(0, MAX_SPEC_CHARS),
    constitutionBody: ctx.constitutionBody ?? '',
    adrCtx,
    designGrounding,
  });

  let output: string;
  try {
    const result = await router.run('check_design', prompt, {
      worktree: ctx.worktree,
      timeoutSeconds: timeoutSeconds ?? 1800,
      env: ctx.env,
      onPgid: ctx.onPgid,
    });
    output = result.output;
  } catch (e: any) {
    return {
      checker: DESIGN_SMELLS_CHECKER,
      result: 'SKIP',
      details: `design critic unavailable: ${(e?.stderr || e?.message || String(e)).slice(0, 300)}`,
    };
  }

  const { verdict, rejected, reason } = parseDesignSmellVerdict(output);
  if (verdict === null) {
    // Fail closed: an unreadable verdict is not evidence of a clean diff (#643),
    // matching runCustomChecker in ./index.ts.
    return { checker: DESIGN_SMELLS_CHECKER, result: 'FAIL', details: reason ?? 'critic produced no valid JSON' };
  }

  const truncationNote = diff.truncated
    ? ` (diff was truncated — critique covers the first ${MAX_DIFF_CHARS} characters)`
    : '';
  const rejectionNote = rejected.length > 0 ? `; ${renderRejectedSmells(rejected)}` : '';

  if (verdict.smells.length > 0) {
    return {
      checker: DESIGN_SMELLS_CHECKER,
      result: 'FAIL',
      details: `${renderSmellDetails(verdict.smells)}${rejectionNote}${truncationNote}`,
    };
  }

  if (rejected.length > 0) {
    return {
      checker: DESIGN_SMELLS_CHECKER,
      result: 'FAIL',
      details: `no usable findings — ${renderRejectedSmells(rejected)}${truncationNote}`,
    };
  }

  const mismatchNote =
    verdict.result === 'FAIL' ? ' (critic returned FAIL with no located findings — not actionable)' : '';
  return {
    checker: DESIGN_SMELLS_CHECKER,
    result: 'PASS',
    details: `no program-design smells found in the diff${mismatchNote}`,
  };
}
