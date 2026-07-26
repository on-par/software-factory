// src/issue.ts — The engineering-ready work-item seam: what the proposer exports and the
// writer ingests (#466). Field names mirror .github/ISSUE_TEMPLATE/*.yml.
import { z } from 'zod';

import { VerificationStepSchema } from './design.js';
import { AcceptanceCriterionSchema } from './gherkin.js';
import { TracesToSchema } from './trace.js';

/** Bumped when a field is removed or its meaning changes; additive fields do not bump it. */
export const CONTRACTS_SCHEMA_VERSION = 1;

export const IssueKindSchema = z.enum(['epic', 'story', 'task', 'bug']);

export const EngineeringReadyIssueSchema = z.object({
  schemaVersion: z.literal(CONTRACTS_SCHEMA_VERSION).default(CONTRACTS_SCHEMA_VERSION),
  /** GitHub issue number, once filed. Absent while the proposer still holds it. */
  number: z.number().int().positive().optional(),
  kind: IssueKindSchema,
  title: z.string().min(1),
  problemStatement: z.string().min(1),
  inScope: z.array(z.string().min(1)).min(1),
  outOfScope: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  verification: z.array(VerificationStepSchema).min(1),
  filesLikelyTouched: z.array(z.string().min(1)),
  labels: z.array(z.string().min(1)),
  /** Intent statement IDs this artifact realizes (#471). Additive — does not bump the schema version. */
  tracesTo: TracesToSchema.default([]),
});

export const StorySchema = EngineeringReadyIssueSchema.extend({
  kind: z.literal('story'),
  role: z.string().min(1),
  want: z.string().min(1),
  soThat: z.string().min(1),
  investNote: z.string().min(1).optional(),
  /** Parent epic's GitHub issue number. */
  epic: z.number().int().positive().optional(),
});

export const EpicSchema = z.object({
  schemaVersion: z.literal(CONTRACTS_SCHEMA_VERSION).default(CONTRACTS_SCHEMA_VERSION),
  number: z.number().int().positive().optional(),
  kind: z.literal('epic'),
  title: z.string().min(1),
  why: z.string().min(1),
  doneWhen: z.array(z.string().min(1)).min(1),
  /** Child stories: titles or "#123" references, in build order. */
  children: z.array(z.string().min(1)),
  whatAlreadyExists: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)),
  /** Intent statement IDs this artifact realizes (#471). Additive — does not bump the schema version. */
  tracesTo: TracesToSchema.default([]),
});

export type IssueKind = z.infer<typeof IssueKindSchema>;
export type EngineeringReadyIssue = z.infer<typeof EngineeringReadyIssueSchema>;
export type Story = z.infer<typeof StorySchema>;
export type Epic = z.infer<typeof EpicSchema>;
