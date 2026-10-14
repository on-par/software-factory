import { isParkKind, type FactoryEvent } from '@on-par/factory-core';
import { factoryBranchIssue } from '@on-par/factory-core/internal';
import type { OpenPullRequestEvidence } from './queue-preflight.js';

/** A stranded draft PR a requeued issue continues on (#2253). */
export interface ReworkPr {
  number: number;
  branch: string;
  headSha: string;
}

/** The issue's most recent park event, or undefined when it never parked. */
export function lastParkEvent(events: FactoryEvent[], issue: number): FactoryEvent | undefined {
  const id = String(issue);
  return events.filter((e) => e.issue === id && isParkKind(e.type)).at(-1);
}

/** Adopt only a same-repo factory-branch draft PR for this issue whose last park was ci-failed. */
export function decideReworkAdoption(input: {
  issue: number;
  pr: OpenPullRequestEvidence;
  expectedHeadRepoFullName: string;
  branchPrefix?: string;
  lastPark: FactoryEvent | undefined;
}): ReworkPr | undefined {
  const { issue, pr, expectedHeadRepoFullName, branchPrefix, lastPark } = input;
  if (lastPark?.type !== 'ci-failed') return undefined;
  if (pr.headRepoFullName !== expectedHeadRepoFullName) return undefined;
  if (factoryBranchIssue(pr.branch, branchPrefix) !== issue) return undefined;
  return { number: pr.number, branch: pr.branch, headSha: pr.headSha };
}

/** Markdown section appended to the work brief so the worker sees the prior CI failure. */
export function renderReworkBrief(pr: ReworkPr, park: FactoryEvent | undefined): string {
  const lines = [
    `## Prior CI failure (adopted PR #${pr.number})`,
    '',
    `- Branch: ${pr.branch}`,
    `- Head SHA: ${pr.headSha}`,
  ];
  if (park) lines.push(`- Parked at: ${park.ts}`, `- Park message: ${park.msg}`);
  const ci = park?.ciFailure;
  if (ci) {
    if (ci.failingChecks.length > 0) {
      lines.push('', 'Failing checks:');
      for (const c of ci.failingChecks) {
        lines.push(`- ${c.name} (${c.conclusion})${c.summary ? `: ${c.summary}` : ''}`);
      }
    }
    if (ci.alerts.length > 0) {
      lines.push('', 'Code-scanning alerts:');
      for (const a of ci.alerts) lines.push(`- ${a.ruleId} @ ${a.location}: ${a.message}`);
    }
    if (ci.truncated) lines.push('', '(Evidence was truncated; see the PR checks for the full list.)');
  }
  lines.push('', 'Fix these failures on top of the existing branch; do not start over.');
  return lines.join('\n');
}

/** The `rework-adopted` event message: which PR was adopted and what failed on it. */
export function describeAdoption(pr: ReworkPr, park: FactoryEvent | undefined): string {
  const checks = park?.ciFailure?.failingChecks.map((c) => c.name).join(', ');
  return `adopting PR #${pr.number} (${pr.branch} @ ${pr.headSha.slice(0, 12)}) after ci-failed park${checks ? `; failing checks: ${checks}` : ''}`;
}
