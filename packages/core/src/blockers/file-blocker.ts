// src/blockers/file-blocker.ts — deterministic filer for one prerequisite ("blocker") child
// of a parent issue (#2316).
//
// Takes one validated claim, files it as a factory-task child, links it as a native
// sub-issue and adds it to the parent's blocked_by list. Idempotent via a body marker,
// duplicate-guarded (ADR-0106), bounded (3 children per parent, depth 2, per-day cap) and
// fail-closed on unverifiable listings (ADR-0018). It does not decide when to file.

import { createHash } from 'node:crypto';

import type { Octokit } from '@octokit/rest';
import { z } from 'zod';

import type { FilingPolicy } from '../filing/policy.js';
import { findDuplicateStory } from '../readiness/duplicate-guard.js';
import { MAX_ACCEPTANCE_CRITERIA_ITEMS, MAX_IN_SCOPE_ITEMS } from '../readiness/size.js';
import { addBlockedBy, listBlockedBy } from './dependencies.js';

export const MAX_BLOCKER_CHILDREN = 3;
const BLOCKER_MARKER_PREFIX = '<!-- factory-blocker v1 ';

export const BlockerClaimSchema = z.object({
  title: z.string().trim().min(1).max(256),
  problem: z.string().min(1),
  inScope: z.array(z.string().min(1)).min(1).max(MAX_IN_SCOPE_ITEMS),
  acceptance: z.array(z.string().min(1)).min(1).max(MAX_ACCEPTANCE_CRITERIA_ITEMS),
});

export type BlockerClaim = z.infer<typeof BlockerClaimSchema>;

export type BlockerRefusalReason =
  | 'invalid-claim'
  | 'parent-is-blocker'
  | 'max-blockers-reached'
  | 'daily-cap-reached'
  | 'listing-unverified'
  | 'create-failed'
  | 'link-failed';

export class BlockerFilingError extends Error {
  readonly reason: BlockerRefusalReason;
  readonly childNumber?: number;

  constructor(reason: BlockerRefusalReason, message: string, childNumber?: number) {
    super(message);
    this.name = 'BlockerFilingError';
    this.reason = reason;
    if (childNumber !== undefined) {
      this.childNumber = childNumber;
    }
  }
}

export type FileBlockerResult =
  | { outcome: 'filed'; number: number }
  | { outcome: 'existing'; number: number }
  | { outcome: 'duplicate'; number: number; title: string; similarity: number };

export interface FileBlockerDeps {
  octokit: Octokit;
  repo: string; // 'owner/name'
  parent: number;
  claim: unknown;
  policy: Pick<FilingPolicy, 'maxPerDay'>;
  now?: () => Date;
}

interface SubIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state?: string;
}

const errorDetail = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function hashBlockerClaim(claim: BlockerClaim): string {
  const normalized = JSON.stringify([
    claim.title.trim(),
    claim.problem.trim(),
    claim.inScope.map((item) => item.trim()),
    claim.acceptance.map((item) => item.trim()),
  ]);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/** Matches the marker of any factory-filed blocker, whatever its parent or hash. */
export const BLOCKER_MARKER_RE = /<!-- factory-blocker v1 parent:\d+ hash:/;

export function blockerMarker(parent: number, hash: string): string {
  return `<!-- factory-blocker v1 parent:${parent} hash:${hash} -->`;
}

export function renderBlockerBody(claim: BlockerClaim, parent: number, hash: string): string {
  return [
    '## Problem statement',
    '',
    claim.problem,
    '',
    '## In scope',
    '',
    ...claim.inScope.map((item) => `- ${item}`),
    '',
    '## Out of scope',
    '',
    '- Anything beyond the in-scope items above.',
    '',
    '## Acceptance criteria',
    '',
    ...claim.acceptance.map((item) => `- [ ] ${item}`),
    '',
    '## Verification',
    '',
    '- bash scripts/verify.sh --no-e2e — passes when: it exits 0',
    '',
    '---',
    '',
    `Filed by the factory as a prerequisite blocking #${parent}.`,
    blockerMarker(parent, hash),
  ].join('\n');
}

function hasBlockerMarker(body: string | null | undefined): boolean {
  return body?.includes(BLOCKER_MARKER_PREFIX) === true;
}

function isBlockerChildOf(body: string | null | undefined, parent: number): boolean {
  return new RegExp(`<!-- factory-blocker v1 parent:${parent} hash:[0-9a-f]+ -->`).test(body ?? '');
}

function unverified(what: string, error: unknown): BlockerFilingError {
  return new BlockerFilingError('listing-unverified', `could not verify ${what}: ${errorDetail(error)}`);
}

async function readParentGuard(octokit: Octokit, owner: string, repo: string, parent: number): Promise<void> {
  let body: string | null | undefined;
  try {
    body = (await octokit.rest.issues.get({ owner, repo, issue_number: parent })).data.body;
  } catch (error) {
    throw unverified(`parent #${parent}`, error);
  }
  if (hasBlockerMarker(body)) {
    throw new BlockerFilingError('parent-is-blocker', `#${parent} is itself a blocker child (depth limit 2)`);
  }
}

async function readSubIssues(octokit: Octokit, owner: string, repo: string, parent: number): Promise<SubIssue[]> {
  let items: unknown;
  try {
    items = await octokit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
      owner,
      repo,
      issue_number: parent,
      per_page: 100,
    });
  } catch (error) {
    throw unverified(`sub-issues of #${parent}`, error);
  }
  if (!Array.isArray(items)) {
    throw unverified(`sub-issues of #${parent}`, 'payload is not an array');
  }
  return items as SubIssue[];
}

async function countFiledToday(octokit: Octokit, owner: string, repo: string, start: Date): Promise<number> {
  let items: unknown;
  try {
    items = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
      owner,
      repo,
      state: 'all',
      since: start.toISOString(),
      per_page: 100,
    });
  } catch (error) {
    throw unverified('issues filed today', error);
  }
  if (!Array.isArray(items)) {
    throw unverified('issues filed today', 'payload is not an array');
  }
  return (items as { pull_request?: unknown; created_at: string; body?: string | null }[]).filter(
    (item) =>
      item.pull_request === undefined && Date.parse(item.created_at) >= start.getTime() && hasBlockerMarker(item.body),
  ).length;
}

async function healExisting(deps: FileBlockerDeps, existing: SubIssue): Promise<void> {
  try {
    const blockedBy = await listBlockedBy(deps, deps.parent);
    if (!blockedBy.some((item) => item.number === existing.number)) {
      await addBlockedBy(deps, deps.parent, existing.id);
    }
  } catch (error) {
    throw new BlockerFilingError(
      'link-failed',
      `could not link existing blocker #${existing.number}: ${errorDetail(error)}`,
      existing.number,
    );
  }
}

async function linkChild(deps: FileBlockerDeps, owner: string, repo: string, created: SubIssue): Promise<void> {
  try {
    await deps.octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', {
      owner,
      repo,
      issue_number: deps.parent,
      sub_issue_id: created.id,
    });
    await addBlockedBy(deps, deps.parent, created.id);
  } catch (error) {
    throw new BlockerFilingError(
      'link-failed',
      `filed #${created.number} but could not link it to #${deps.parent}: ${errorDetail(error)}`,
      created.number,
    );
  }
}

export async function fileBlocker(deps: FileBlockerDeps): Promise<FileBlockerResult> {
  const { octokit, parent } = deps;
  const [owner, repo] = deps.repo.split('/') as [string, string];
  const now = (deps.now ?? (() => new Date()))();

  const parsed = BlockerClaimSchema.safeParse(deps.claim);
  if (!parsed.success) {
    throw new BlockerFilingError('invalid-claim', parsed.error.issues.map((issue) => issue.message).join('; '));
  }
  const claim = parsed.data;
  const hash = hashBlockerClaim(claim);
  const body = renderBlockerBody(claim, parent, hash);

  await readParentGuard(octokit, owner, repo, parent);
  const subIssues = await readSubIssues(octokit, owner, repo, parent);

  const marker = blockerMarker(parent, hash);
  const existing = subIssues.find((item) => item.body?.includes(marker) === true);
  if (existing !== undefined) {
    await healExisting(deps, existing);
    return { outcome: 'existing', number: existing.number };
  }

  if (subIssues.filter((item) => isBlockerChildOf(item.body, parent)).length >= MAX_BLOCKER_CHILDREN) {
    throw new BlockerFilingError(
      'max-blockers-reached',
      `#${parent} already has ${MAX_BLOCKER_CHILDREN} blocker children`,
    );
  }

  const openSiblings = subIssues
    .filter((item) => item.state === 'open')
    .map((item) => ({ number: item.number, title: item.title, body: item.body ?? null }));
  const duplicate = findDuplicateStory(`${claim.title} ${body}`, openSiblings);
  if (duplicate !== undefined) {
    return { outcome: 'duplicate', ...duplicate };
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if ((await countFiledToday(octokit, owner, repo, start)) >= deps.policy.maxPerDay) {
    throw new BlockerFilingError('daily-cap-reached', `daily blocker filing cap of ${deps.policy.maxPerDay} reached`);
  }

  let created: SubIssue;
  try {
    const response = await octokit.rest.issues.create({ owner, repo, title: claim.title, body });
    created = { id: response.data.id, number: response.data.number, title: claim.title };
  } catch (error) {
    throw new BlockerFilingError('create-failed', `could not create blocker issue: ${errorDetail(error)}`);
  }

  await linkChild(deps, owner, repo, created);
  return { outcome: 'filed', number: created.number };
}
