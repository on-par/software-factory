// packages/product/src/judge/rubric.ts — the deterministic default judge + reworker (#474).

import type { Story } from '@on-par/contracts';

import { checkInvest } from '../decompose/index.js';
import type { IntentDoc } from '../intent/index.js';
import type { IntentDimension } from '../interview/index.js';
import type { JudgeVerdict, RubricCheck } from './verdict.js';

function statementIdsOf(doc: IntentDoc, dimension: IntentDimension): ReadonlySet<string> {
  return new Set(doc.statements.filter((s) => s.dimension === dimension).map((s) => s.id));
}

function firstStatementId(doc: IntentDoc, dimension: IntentDimension): string | undefined {
  return doc.statements.find((s) => s.dimension === dimension)?.id;
}

/** Six equally-weighted checks against the approved intent doc. Pure, deterministic. */
export function judgeStoryAgainstIntent(story: Story, doc: IntentDoc): JudgeVerdict {
  const allStatementIds = new Set(doc.statements.map((s) => s.id));
  const scopeIds = statementIdsOf(doc, 'scope');
  const outcomeIds = statementIdsOf(doc, 'outcome');
  const nonGoalStatements = doc.statements.filter((s) => s.dimension === 'nonGoals');

  const unresolved = [...new Set([...story.tracesTo, ...story.acceptanceCriteria.flatMap((c) => c.tracesTo)])].filter(
    (id) => !allStatementIds.has(id),
  );

  const untracedCriteria = story.acceptanceCriteria.filter((c) => c.tracesTo.length === 0);

  const investReport = checkInvest(story);

  const checks: readonly RubricCheck[] = [
    {
      id: 'traces-resolve',
      label: 'Every traced intent statement ID resolves in the doc',
      passed: unresolved.length === 0,
      note:
        unresolved.length === 0
          ? 'every traced ID resolves to a statement in the doc'
          : `unresolved trace ids: ${unresolved.join(', ')}`,
    },
    {
      id: 'cites-scope',
      label: 'The story traces to a scope statement',
      passed: story.tracesTo.some((id) => scopeIds.has(id)),
      note: story.tracesTo.some((id) => scopeIds.has(id))
        ? 'traces to a scope statement'
        : 'story.tracesTo cites no scope statement',
    },
    {
      id: 'cites-outcome',
      label: 'The story traces to an outcome statement',
      passed: story.tracesTo.some((id) => outcomeIds.has(id)),
      note: story.tracesTo.some((id) => outcomeIds.has(id))
        ? 'traces to an outcome statement'
        : 'story.tracesTo cites no outcome statement — "so that" does not trace to real intent value',
    },
    {
      id: 'invest-clean',
      label: 'The story passes the INVEST gate',
      passed: investReport.ok,
      note: investReport.ok
        ? 'passes the INVEST gate'
        : investReport.violations.map((v) => `${v.letter}: ${v.reason}`).join('; '),
    },
    {
      id: 'non-goals-captured',
      label: 'Named non-goals are carried onto the story',
      passed: nonGoalStatements.length === 0 || story.outOfScope.length > 0,
      note:
        nonGoalStatements.length === 0 || story.outOfScope.length > 0
          ? 'non-goals are captured or none were named'
          : 'intent names non-goals but story.outOfScope is empty',
    },
    {
      id: 'criteria-trace',
      label: 'Every acceptance criterion traces to intent',
      passed: untracedCriteria.length === 0,
      note:
        untracedCriteria.length === 0
          ? 'every acceptance criterion traces to intent'
          : `criteria with no tracesTo: ${untracedCriteria.map((c) => c.name).join(', ')}`,
    },
  ];

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const failed = checks.filter((c) => !c.passed);
  const rationale = failed.length === 0 ? `All ${checks.length} checks passed.` : failed.map((c) => c.note).join('; ');

  return { score, rationale, checks };
}

/** The deterministic critic: fixes what it can, leaves the rest for the loop to judge honestly. */
export function reworkStoryMechanically(story: Story, verdict: JudgeVerdict, doc: IntentDoc): Story {
  const failedIds = new Set(verdict.checks.filter((c) => !c.passed).map((c) => c.id));
  if (failedIds.size === 0) {
    return story;
  }

  const allStatementIds = new Set(doc.statements.map((s) => s.id));
  let tracesTo = story.tracesTo;
  let acceptanceCriteria = story.acceptanceCriteria;
  let outOfScope = story.outOfScope;
  let fixed = false;

  if (failedIds.has('traces-resolve')) {
    tracesTo = tracesTo.filter((id) => allStatementIds.has(id));
    acceptanceCriteria = acceptanceCriteria.map((c) => ({
      ...c,
      tracesTo: c.tracesTo.filter((id) => allStatementIds.has(id)),
    }));
    fixed = true;
  }

  if (failedIds.has('cites-scope')) {
    const scopeId = firstStatementId(doc, 'scope');
    if (scopeId !== undefined) {
      tracesTo = [...tracesTo, scopeId];
      fixed = true;
    }
  }

  if (failedIds.has('cites-outcome')) {
    const outcomeId = firstStatementId(doc, 'outcome');
    if (outcomeId !== undefined) {
      tracesTo = [...tracesTo, outcomeId];
      fixed = true;
    }
  }

  if (failedIds.has('non-goals-captured')) {
    outOfScope = doc.statements.filter((s) => s.dimension === 'nonGoals').map((s) => s.text);
    fixed = true;
  }

  if (failedIds.has('criteria-trace')) {
    acceptanceCriteria = acceptanceCriteria.map((c) => (c.tracesTo.length === 0 ? { ...c, tracesTo } : c));
    fixed = true;
  }

  if (!fixed) {
    return story;
  }

  return { ...story, tracesTo, acceptanceCriteria, outOfScope };
}
