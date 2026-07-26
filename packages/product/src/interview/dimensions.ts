// packages/product/src/interview/dimensions.ts — the six dimensions of pinned intent (#470).

export type IntentDimension = 'problem' | 'audience' | 'outcome' | 'scope' | 'nonGoals' | 'constraints';

export interface DimensionProbe {
  dimension: IntentDimension;
  /** Human label used in prompts and summaries. */
  label: string;
  /** The default clarifying question asked when this dimension is a gap. */
  question: string;
  /** Lowercase substrings that count as "the dump already says something here". */
  cues: readonly string[];
}

export const DIMENSION_PROBES: readonly DimensionProbe[] = [
  {
    dimension: 'problem',
    label: 'Problem',
    question: 'What is broken today, and what does it cost each time it happens?',
    cues: [
      'problem',
      'pain',
      'broken',
      'breaks',
      'fails',
      'failing',
      'slow',
      'manual',
      'wastes',
      'frustrat',
      'bug',
      'hard to',
      'cannot',
      "can't",
    ],
  },
  {
    dimension: 'audience',
    label: 'Audience',
    question: 'Who has this problem — which role or user, specifically?',
    cues: [
      'as a',
      'user',
      'customer',
      'pm',
      'engineer',
      'developer',
      'team',
      'operator',
      'admin',
      'persona',
      'audience',
    ],
  },
  {
    dimension: 'outcome',
    label: 'Outcome',
    question: 'What is true once this is solved, and how would we measure it?',
    cues: [
      'so that',
      'success',
      'measure',
      'metric',
      'kpi',
      'outcome',
      'goal',
      'target',
      'reduce',
      'increase',
      'faster',
      'we will know',
      "we'll know",
    ],
  },
  {
    dimension: 'scope',
    label: 'Scope',
    question: 'What is the smallest change that delivers that outcome?',
    cues: ['build', 'add ', 'support', 'ship', 'feature', 'implement', 'create', 'change', 'we need'],
  },
  {
    dimension: 'nonGoals',
    label: 'Non-goals',
    question: 'What are we explicitly NOT doing in this first slice?',
    cues: [
      'out of scope',
      'not doing',
      'non-goal',
      'nongoal',
      "won't",
      'will not',
      'later',
      'defer',
      'exclude',
      'not include',
    ],
  },
  {
    dimension: 'constraints',
    label: 'Constraints',
    question: 'What constrains this — deadline, platform, compliance, or systems it must not break?',
    cues: [
      'deadline',
      'must ',
      'compliance',
      'gdpr',
      'soc2',
      'budget',
      'constraint',
      'limit',
      'existing',
      'legacy',
      'platform',
      'requires',
      'only ',
    ],
  },
];

export const INTENT_DIMENSIONS: readonly IntentDimension[] = DIMENSION_PROBES.map((p) => p.dimension);

const BY_DIMENSION = new Map(DIMENSION_PROBES.map((p) => [p.dimension, p]));

/** The probe for a dimension. Total over IntentDimension — the map is built from the same list. */
export function probeFor(dimension: IntentDimension): DimensionProbe {
  return BY_DIMENSION.get(dimension)!;
}
