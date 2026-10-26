// packages/core/src/readiness/parent-coverage.ts — merged-child coverage of a decomposed parent's criteria (#3108).
//
// The size gate (#3105) puts a `Covers parent criteria: P1, P3` line in every child it files. This module reads
// those traces back: a parent criterion is covered once a child that lists it has merged (closed as completed).
// Parents are never closed or relabeled here; the one marker comment is the only write.

import type { Octokit } from '@octokit/rest';
import { isParentCriterionId } from '@on-par/contracts';

import type { EventKind } from '../events/kinds.js';
import { stripHiddenContent } from '../filing/sanitize.js';
import { DECOMPOSED_LABEL } from '../queue/github-queue.js';
import { parseParentCriteria } from './decompose-coverage.js';
import type { ParentCriterion } from './decompose-prompt.js';

export interface ChildIssueSummary {
  number: number;
  body: string | null;
  merged: boolean;
}

export interface ParentCoverage {
  parent: number;
  title?: string;
  /** All parsed parent criteria, in P order. */
  criteria: ParentCriterion[];
  covered: ParentCriterion[];
  uncovered: ParentCriterion[];
  /** Criterion id -> merged child issue numbers that cover it. */
  coveredBy: Record<string, number[]>;
  /** True only when there is at least one criterion and every one has a merged child. */
  fullyCovered: boolean;
}

export const PARENT_COVERAGE_MARKER = '<!-- factory-parent-coverage v1 -->';

const PAGE_SIZE = 100;
const MAX_PARENT_PAGES = 20;

function idNumber(id: string): number {
  return Number(id.slice(1));
}

export function parseCoveredParentIds(body: string | null | undefined): string[] {
  const match = /^Covers parent criteria:\s*(.+)$/m.exec(body ?? '');
  if (!match) return [];
  const ids = match[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => isParentCriterionId(s));
  return [...new Set(ids)].sort((a, b) => idNumber(a) - idNumber(b));
}

export function parseDecomposedFromParent(body: string | null | undefined): number | null {
  const match = /Decomposed from #(\d+) by the factory size gate\./.exec(body ?? '');
  return match ? Number(match[1]) : null;
}

export function computeParentCoverage(
  parent: { number: number; title?: string; body: string | null },
  children: readonly ChildIssueSummary[],
): ParentCoverage {
  const criteria = parseParentCriteria(parent.body ?? '');
  const known = new Set(criteria.map((c) => c.id));
  const coveredBy: Record<string, number[]> = {};
  for (const child of children) {
    if (!child.merged) continue;
    for (const id of parseCoveredParentIds(child.body)) {
      if (!known.has(id)) continue;
      (coveredBy[id] ??= []).push(child.number);
    }
  }
  const covered = criteria.filter((c) => coveredBy[c.id] !== undefined);
  const uncovered = criteria.filter((c) => coveredBy[c.id] === undefined);
  return {
    parent: parent.number,
    ...(parent.title === undefined ? {} : { title: parent.title }),
    criteria,
    covered,
    uncovered,
    coveredBy,
    fullyCovered: criteria.length > 0 && uncovered.length === 0,
  };
}

export function formatParentCoverageLine(coverage: ParentCoverage): string {
  if (coverage.criteria.length === 0) return `parent #${coverage.parent}: no checkbox acceptance criteria to trace`;
  const line = `parent #${coverage.parent}: ${coverage.covered.length}/${coverage.criteria.length} criteria covered`;
  return coverage.fullyCovered ? `${line} (fully covered)` : line;
}

export function renderParentCoverageComment(coverage: ParentCoverage): string {
  const lines = [PARENT_COVERAGE_MARKER, '### Parent criteria coverage', ''];
  lines.push(`**${coverage.covered.length}/${coverage.criteria.length}** parent criteria have a merged child.`, '');
  if (coverage.criteria.length === 0) {
    lines.push('This parent has no checkbox acceptance criteria to trace.');
  } else if (coverage.fullyCovered) {
    lines.push('All parent criteria have a merged child.');
  } else {
    lines.push('**Uncovered criteria:**');
    for (const c of coverage.uncovered) lines.push(`- ${c.id}: ${stripHiddenContent(c.text)}`);
    lines.push('', 'This parent stays open until every criterion has a merged child.');
  }
  if (coverage.covered.length > 0) {
    lines.push('', '**Covered:**');
    for (const c of coverage.covered) {
      const by = coverage.coveredBy[c.id].map((n) => `#${n}`).join(', ');
      lines.push(`- ${c.id}: ${stripHiddenContent(c.text)} (${by})`);
    }
  }
  return lines.join('\n');
}

function splitRepo(repo: string): [string, string] {
  const [owner, name] = repo.split('/');
  return [owner, name];
}

interface SubIssue {
  number: number;
  body?: string | null;
  state: string;
  state_reason?: string | null;
}

export async function readParentCoverage(deps: {
  octokit: Octokit;
  repo: string;
  parent: number;
}): Promise<ParentCoverage> {
  const { octokit, repo, parent } = deps;
  const [owner, name] = splitRepo(repo);
  const { data: issue } = await octokit.rest.issues.get({ owner, repo: name, issue_number: parent });
  const children: ChildIssueSummary[] = [];
  for (let page = 1; ; page++) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
      owner,
      repo: name,
      issue_number: parent,
      per_page: PAGE_SIZE,
      page,
    });
    const items = res.data as SubIssue[];
    for (const s of items) {
      children.push({
        number: s.number,
        body: s.body ?? null,
        merged: s.state === 'closed' && s.state_reason === 'completed',
      });
    }
    if (items.length < PAGE_SIZE) break;
  }
  return computeParentCoverage({ number: parent, title: issue.title, body: issue.body ?? null }, children);
}

/** Coverage of every open `factory:decomposed` parent, oldest first; null when any lookup fails. */
export async function listDecomposedParentCoverage(deps: {
  octokit: Octokit;
  repo: string;
}): Promise<ParentCoverage[] | null> {
  const { octokit, repo } = deps;
  const [owner, name] = splitRepo(repo);
  try {
    const parents: number[] = [];
    for (let page = 1; page <= MAX_PARENT_PAGES; page++) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo: name,
        state: 'open',
        labels: DECOMPOSED_LABEL,
        per_page: PAGE_SIZE,
        page,
      });
      for (const item of data) if (!item.pull_request) parents.push(item.number);
      if (data.length < PAGE_SIZE) break;
    }
    parents.sort((a, b) => a - b);
    const out: ParentCoverage[] = [];
    for (const parent of parents) out.push(await readParentCoverage({ octokit, repo, parent }));
    return out;
  } catch {
    return null;
  }
}

/** Creates the coverage comment, or rewrites the authenticated identity's existing one in place. */
export async function upsertParentCoverageComment(deps: {
  octokit: Octokit;
  repo: string;
  coverage: ParentCoverage;
}): Promise<{ commentId: number; created: boolean }> {
  const { octokit, repo, coverage } = deps;
  const [owner, name] = splitRepo(repo);
  const body = renderParentCoverageComment(coverage);
  const { data: me } = await octokit.rest.users.getAuthenticated();
  for (let page = 1; ; page++) {
    const { data } = await octokit.rest.issues.listComments({
      owner,
      repo: name,
      issue_number: coverage.parent,
      per_page: PAGE_SIZE,
      page,
    });
    const existing = data.find((c) => c.user?.id === me.id && (c.body ?? '').startsWith(PARENT_COVERAGE_MARKER));
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo: name, comment_id: existing.id, body });
      return { commentId: existing.id, created: false };
    }
    if (data.length < PAGE_SIZE) break;
  }
  const { data } = await octokit.rest.issues.createComment({ owner, repo: name, issue_number: coverage.parent, body });
  return { commentId: data.id, created: true };
}

/** After a child merges, refreshes its parent's coverage comment. Best-effort: never throws. */
export async function refreshParentCoverageAfterMerge(deps: {
  octokit: Octokit;
  repo: string;
  childIssue: number;
  log: (type: EventKind, msg: string) => void;
}): Promise<ParentCoverage | null> {
  const { octokit, repo, childIssue, log } = deps;
  try {
    const [owner, name] = splitRepo(repo);
    const { data: child } = await octokit.rest.issues.get({ owner, repo: name, issue_number: childIssue });
    const parent = parseDecomposedFromParent(child.body);
    if (parent === null) return null;
    const coverage = await readParentCoverage({ octokit, repo, parent });
    await upsertParentCoverageComment({ octokit, repo, coverage });
    log('land', `parent #${parent} coverage: ${coverage.covered.length}/${coverage.criteria.length} criteria covered`);
    return coverage;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log('warn', `parent coverage refresh for #${childIssue} failed: ${detail}`);
    return null;
  }
}
