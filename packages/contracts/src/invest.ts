// src/invest.ts — The INVEST gate for a Story (#472, moved from @on-par/product in #606).

import type { Story } from './issue.js';

export type InvestLetter = 'independent' | 'negotiable' | 'valuable' | 'estimable' | 'small' | 'testable';

export interface InvestViolation {
  letter: InvestLetter;
  reason: string;
}

export interface InvestReport {
  ok: boolean;
  violations: readonly InvestViolation[];
}

/** A story with more in-scope bullets than this has stopped being one slice. */
export const MAX_IN_SCOPE = 5;
/** More acceptance criteria than this and the story is really several stories. */
export const MAX_ACCEPTANCE_CRITERIA = 5;

/** Lowercase substrings that mark a story as depending on other work. */
const DEPENDENCY_CUES: readonly string[] = ['depends on', 'after we', 'once the', 'blocked by', 'requires story'];

function firstDependencyHit(story: Story): string | undefined {
  return [story.want, ...story.inScope].find((text) => DEPENDENCY_CUES.some((cue) => text.toLowerCase().includes(cue)));
}

function firstUntestableCriterion(story: Story): Story['acceptanceCriteria'][number] | undefined {
  return story.acceptanceCriteria.find((c) => c.when.length === 0 || c.then.length === 0);
}

/** Six predicates, each decidable on a bare Story. Every branch is independently reachable. */
export function checkInvest(story: Story): InvestReport {
  const violations: InvestViolation[] = [];

  const dependencyHit = firstDependencyHit(story);
  if (dependencyHit !== undefined) {
    violations.push({ letter: 'independent', reason: `depends on other work: "${dependencyHit}"` });
  }

  if (story.outOfScope.length === 0) {
    violations.push({ letter: 'negotiable', reason: 'no out-of-scope boundary — nothing left to negotiate' });
  }

  if (!(story.tracesTo.length > 0 && story.soThat.trim() !== '')) {
    violations.push({ letter: 'valuable', reason: 'does not trace to intent, or has no "so that" value' });
  }

  if (!(story.acceptanceCriteria.length > 0 && story.verification.length > 0)) {
    violations.push({ letter: 'estimable', reason: 'no acceptance criteria or no verification step to size against' });
  }

  if (!(story.inScope.length <= MAX_IN_SCOPE && story.acceptanceCriteria.length <= MAX_ACCEPTANCE_CRITERIA)) {
    violations.push({
      letter: 'small',
      reason: `too big: ${story.inScope.length} in-scope items, ${story.acceptanceCriteria.length} acceptance criteria`,
    });
  }

  const untestable = firstUntestableCriterion(story);
  if (untestable !== undefined) {
    violations.push({ letter: 'testable', reason: `criterion "${untestable.name}" has no When or no Then` });
  }

  return { ok: violations.length === 0, violations };
}
