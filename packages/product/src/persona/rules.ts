// packages/product/src/persona/rules.ts — the ten persona rules (#473).

import type { Story } from '@on-par/contracts';

import type { IntentDoc } from '../intent/index.js';
import type { PersonaRule } from './findings.js';
import { askQuestion, proposeCriterion } from './findings.js';

/** True when any cue appears in any of the texts (case-insensitive substring match). */
export function mentions(texts: readonly string[], cues: readonly string[]): boolean {
  const haystack = texts.join(' \n ').toLowerCase();
  return cues.some((cue) => haystack.includes(cue));
}

/** Every piece of prose a story carries — title, narrative, scope, criteria, verification. */
export function storyText(story: Story): string[] {
  return [
    story.title,
    story.want,
    story.soThat,
    story.role,
    story.problemStatement,
    ...story.inScope,
    ...story.outOfScope,
    ...story.acceptanceCriteria.flatMap((c) => [c.name, ...c.given, ...c.when, ...c.then]),
    ...story.verification.flatMap((v) => [v.command, v.passWhen]),
  ];
}

function constraintTexts(doc: IntentDoc): string[] {
  return doc.statements.filter((s) => s.dimension === 'constraints').map((s) => s.text);
}

export const MEASURABLE_CUES = [
  '%',
  'percent',
  'reduce',
  'fewer',
  'faster',
  'increase',
  'within',
  'per week',
  'per day',
  'under ',
  'at least',
  'no more than',
  'measure',
];
export const ADOPTION_CUES = [
  'onboard',
  'first time',
  'discover',
  'learn',
  'sign up',
  'empty state',
  'default',
  'migrat',
];
export const FAILURE_CUES = [
  'error',
  'fails',
  'failure',
  'invalid',
  'retry',
  'timeout',
  'edge case',
  'unhappy path',
  'empty',
];
export const DOC_CUES = ['runbook', 'documentation', 'document', 'docs', 'help', 'faq', 'support article'];
export const SECURITY_CUES = [
  'auth',
  'permission',
  'rbac',
  'pii',
  'personal data',
  'gdpr',
  'soc2',
  'encrypt',
  'secret',
  'token',
  'audit log',
  'access control',
];
export const DENY_CUES = ['denied', 'rejected', 'blocked', 'forbidden', 'unauthorized', 'must not', 'cannot', 'refuse'];
export const ROLLOUT_CUES = [
  'feature flag',
  'flag',
  'rollout',
  'roll out',
  'rollback',
  'roll back',
  'migration',
  'migrate',
  'canary',
  'staged',
];
export const OBSERVABILITY_CUES = ['log', 'metric', 'alert', 'dashboard', 'monitor', 'trace', 'telemetry', 'observab'];

export const engRepoContextRule: PersonaRule = ({ story }) => {
  if (story.filesLikelyTouched.length > 0) {
    return undefined;
  }
  return askQuestion(
    'eng',
    'assumption',
    story,
    `no repo context is attached to "${story.title}", so sizing it is a guess`,
    `Which files or modules does "${story.want}" touch, and does anything already do part of it?`,
  );
};

export const engAutomatedVerificationRule: PersonaRule = ({ story }) => {
  if (!story.verification.every((v) => v.command.startsWith('manual:'))) {
    return undefined;
  }
  return askQuestion(
    'eng',
    'risk',
    story,
    `every verification step on "${story.title}" is manual`,
    `What exact command proves "${story.soThat}"? A manual check cannot gate CI.`,
  );
};

export const customerMeasurableValueRule: PersonaRule = ({ story }) => {
  if (mentions([story.soThat], MEASURABLE_CUES)) {
    return undefined;
  }
  return askQuestion(
    'customer',
    'assumption',
    story,
    `"${story.soThat}" is not stated in a way a ${story.role} could confirm`,
    `How would a ${story.role} tell that "${story.soThat}" happened — what would they see or measure?`,
  );
};

export const customerAdoptionRule: PersonaRule = ({ story }) => {
  if (mentions(storyText(story), ADOPTION_CUES)) {
    return undefined;
  }
  return proposeCriterion(
    'customer',
    'gap',
    story,
    `nothing in "${story.title}" says how a ${story.role} discovers or starts using it`,
    {
      name: `Customer: a ${story.role} can discover ${story.title}`,
      given: [`a ${story.role} who has never used ${story.want}`],
      when: ['they arrive at the product'],
      then: [`they can find and start ${story.want} without being told it exists`],
    },
  );
};

export const supportFailurePathRule: PersonaRule = ({ story }) => {
  if (mentions(storyText(story), FAILURE_CUES)) {
    return undefined;
  }
  return proposeCriterion(
    'support',
    'gap',
    story,
    `"${story.title}" only describes the happy path — nothing says what a ${story.role} sees when it breaks`,
    {
      name: `Support: ${story.title} fails visibly`,
      given: [`a ${story.role} using ${story.want}`],
      when: ['the operation fails'],
      then: [
        `the ${story.role} sees an actionable error naming what to do next`,
        'support can find the failure in the event log',
      ],
    },
  );
};

export const supportRunbookRule: PersonaRule = ({ story }) => {
  if (mentions(storyText(story), DOC_CUES)) {
    return undefined;
  }
  return askQuestion(
    'support',
    'gap',
    story,
    `no documentation or runbook is named for "${story.title}"`,
    `What does a support agent read when a ${story.role} reports that "${story.want}" is broken?`,
  );
};

export const securityAuthorizationRule: PersonaRule = ({ story, doc }) => {
  if (mentions([...storyText(story), ...constraintTexts(doc)], SECURITY_CUES)) {
    return undefined;
  }
  return askQuestion(
    'security',
    'gap',
    story,
    `neither "${story.title}" nor any constraint says who may do this`,
    `Who is allowed to ${story.want}, and what data does it expose if they are not?`,
  );
};

export const securityAbuseCaseRule: PersonaRule = ({ story }) => {
  if (story.acceptanceCriteria.some((c) => mentions(c.then, DENY_CUES))) {
    return undefined;
  }
  return proposeCriterion(
    'security',
    'risk',
    story,
    `every criterion on "${story.title}" describes the happy path — none says what must not be allowed`,
    {
      name: `Security: ${story.title} refuses the unauthorized case`,
      given: [`someone without permission to ${story.want}`],
      when: ['they attempt it'],
      then: ['the attempt is denied and recorded'],
    },
  );
};

export const opsRollbackRule: PersonaRule = ({ story }) => {
  if (mentions(storyText(story), ROLLOUT_CUES)) {
    return undefined;
  }
  return proposeCriterion('ops', 'risk', story, `"${story.title}" has no rollout, flag, or rollback story`, {
    name: `Ops: ${story.title} can be turned off`,
    given: [`${story.want} is live`],
    when: ['it misbehaves in production'],
    then: ['it can be disabled without a deploy'],
  });
};

export const opsObservabilityRule: PersonaRule = ({ story }) => {
  if (mentions(storyText(story), OBSERVABILITY_CUES)) {
    return undefined;
  }
  return askQuestion(
    'ops',
    'gap',
    story,
    `nothing in "${story.title}" emits a signal on-call could watch`,
    `What signal tells on-call that "${story.soThat}" stopped being true?`,
  );
};
