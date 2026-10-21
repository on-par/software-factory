// packages/grade/src/report-schema.ts — the versioned, runtime-validated GradeReport shared by Grade slices.
import { z } from 'zod';

export const GRADE_REPORT_SCHEMA_VERSION = 1;

export const FAILURE_MODE_KINDS = [
  'redundant-test',
  'relearn-test-command',
  'repeated-failing-command',
  'park-reason-cluster',
  'model-phase-failure',
] as const;

const phase = z.enum(['plan', 'build', 'check', 'ship']);

const evidence = z
  .object({
    issue: z.number().int().positive(),
    phase: phase.optional(),
    /** Where the evidence came from, e.g. "state/events.ndjson" or "runs/issue-101.json". */
    source: z.string().min(1),
    /** Short verbatim excerpt (command line, park reason). */
    excerpt: z.string(),
  })
  .strict();

const failureMode = z
  .object({
    kind: z.enum(FAILURE_MODE_KINDS),
    /** Times the mode was observed across all graded runs. */
    count: z.number().int().nonnegative(),
    /** Issues whose runs exhibit the mode, ascending. */
    issues: z.array(z.number().int().positive()),
    evidence: z.array(evidence),
  })
  .strict();

const runScore = z
  .object({
    issue: z.number().int().positive(),
    repo: z.string().min(1).optional(),
    model: z.string(),
    status: z.string().min(1),
    /** 0 (worst) .. 1 (no failure modes found). */
    score: z.number().min(0).max(1),
  })
  .strict();

export const gradeReportSchema = z
  .object({
    schemaVersion: z.literal(GRADE_REPORT_SCHEMA_VERSION),
    generatedAt: z.iso.datetime(),
    /** The since filter applied, as ISO, or null when none. */
    since: z.iso.datetime().nullable(),
    runCount: z.number().int().nonnegative(),
    scores: z
      .object({
        overall: z.number().min(0).max(1),
        runs: z.array(runScore),
      })
      .strict(),
    failureModes: z.array(failureMode),
  })
  .strict();

export type GradeReport = z.infer<typeof gradeReportSchema>;
export type FailureModeKind = (typeof FAILURE_MODE_KINDS)[number];

export type GradeReportValidation = { ok: true; report: GradeReport } | { ok: false; errors: string[] };

/** Validate unknown JSON against the GradeReport schema; errors are path-qualified. */
export function validateGradeReport(value: unknown): GradeReportValidation {
  const parsed = gradeReportSchema.safeParse(value);
  if (parsed.success) return { ok: true, report: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
  };
}
