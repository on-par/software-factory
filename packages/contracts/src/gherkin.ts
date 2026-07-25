// src/gherkin.ts — Gherkin acceptance criterion: the executable-shaped "done" statement
// carried on every engineering-ready story (#466).
import { z } from 'zod';

export const AcceptanceCriterionSchema = z.object({
  name: z.string().min(1),
  given: z.array(z.string().min(1)),
  when: z.array(z.string().min(1)).min(1),
  then: z.array(z.string().min(1)).min(1),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;
