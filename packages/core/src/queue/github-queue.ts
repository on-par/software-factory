// packages/core/src/queue/github-queue.ts — GitHub-label-backed work queue: claim/release/list (#824).

import { hostname } from 'node:os';

import type { Octokit } from '@octokit/rest';

import type { QueueEntry } from './index.js';

export const QUEUED_LABEL = 'factory:queued';
export const IN_PROGRESS_LABEL = 'factory:in-progress';
export const PARKED_LABEL = 'factory:parked';
export const LANE_LABEL_PREFIX = 'factory:lane:';
export const QUEUE_ORDER_LABEL_PREFIX = 'factory:order:';
export const CLAIMED_BY_LABEL_PREFIX = 'factory:claimed-by:';

/** GitHub's hard limit on a label name. */
export const MAX_LABEL_NAME_LENGTH = 50;

const QUEUED_LABEL_COLOR = '0e8a16';
const LANE_LABEL_COLOR = '1d76db';
const QUEUE_ORDER_LABEL_COLOR = '0052cc';
const IN_PROGRESS_LABEL_COLOR = 'fbca04';
const CLAIMED_BY_LABEL_COLOR = '5319e7';
const PARKED_LABEL_COLOR = 'b60205';

export interface QueueLabelSpec {
  name: string;
  color: string;
  description: string;
}

/** Lowercase, `[a-z0-9-]` only, collapsed and trimmed, capped at `maxLen`. Falls back to 'unknown'. */
function slugSegment(raw: string, maxLen: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return slug === '' ? 'unknown' : slug;
}

export function laneLabel(lane: string): string {
  return LANE_LABEL_PREFIX + slugSegment(lane, MAX_LABEL_NAME_LENGTH - LANE_LABEL_PREFIX.length);
}

/** Renders one-based queue ordering metadata as a GitHub-safe factory label. */
export function queueOrderLabel(position: number): string {
  if (!Number.isSafeInteger(position) || position < 1) {
    throw new RangeError(`queue position must be a positive safe integer, got ${position}`);
  }
  return `${QUEUE_ORDER_LABEL_PREFIX}${position}`;
}

export function claimedByLabel(claimantId: string): string {
  return CLAIMED_BY_LABEL_PREFIX + slugSegment(claimantId, MAX_LABEL_NAME_LENGTH - CLAIMED_BY_LABEL_PREFIX.length);
}

/** Reuses run-lock's holder identity (host + pid, see utils/run-lock.ts) — host alone
 *  collides across concurrent lanes on one machine. */
export function defaultClaimantId(host: string = hostname(), pid: number = process.pid): string {
  const suffix = `-${pid}`;
  const budget = MAX_LABEL_NAME_LENGTH - CLAIMED_BY_LABEL_PREFIX.length - suffix.length;
  return `${slugSegment(host, Math.max(1, budget))}${suffix}`;
}

/** Every label the module may need for one lane/claimant, for create-if-missing. */
export function queueLabelSpecs(lane: string, claimantId: string): QueueLabelSpec[] {
  return [
    { name: QUEUED_LABEL, color: QUEUED_LABEL_COLOR, description: 'Eligible to be claimed by a factory lane' },
    { name: laneLabel(lane), color: LANE_LABEL_COLOR, description: `Routed to factory lane ${lane}` },
    {
      name: IN_PROGRESS_LABEL,
      color: IN_PROGRESS_LABEL_COLOR,
      description: 'Claimed and being worked by a factory lane',
    },
    { name: claimedByLabel(claimantId), color: CLAIMED_BY_LABEL_COLOR, description: `Claimed by ${claimantId}` },
    {
      name: PARKED_LABEL,
      color: PARKED_LABEL_COLOR,
      description: 'Parked — needs human attention before it can be re-queued',
    },
  ];
}

export interface QueueIssue {
  number: number;
  labels: string[];
}

/** A no-model classification made before a queue candidate is claimed. */
export type QueuePreflightDecision =
  { kind: 'build' } | { kind: 'adopt'; branch: string } | { kind: 'park'; reason: string } | { kind: 'defer' };

export type QueuePreflight = (candidate: QueueIssue) => Promise<QueuePreflightDecision>;

/** A successfully claimed issue and the preflight decision that led to the claim. */
export interface QueueClaim {
  issue: number;
  decision: Extract<QueuePreflightDecision, { kind: 'build' | 'adopt' | 'park' }>;
}

export interface QueueGitHubClient {
  /** Open issues carrying ALL of `labels`. Pull requests must be excluded. */
  listOpenIssuesWithLabels(input: { owner: string; repo: string; labels: string[] }): Promise<QueueIssue[]>;
  /** Current label names on one issue. */
  getIssueLabels(input: { owner: string; repo: string; issue_number: number }): Promise<string[]>;
  addLabels(input: { owner: string; repo: string; issue_number: number; labels: string[] }): Promise<void>;
  removeLabel(input: { owner: string; repo: string; issue_number: number; name: string }): Promise<void>;
  /** Create the label if missing. Must be idempotent — an already-existing label is not an error. */
  ensureLabel(input: { owner: string; repo: string } & QueueLabelSpec): Promise<void>;
}

function labelExistsError(err: unknown): boolean {
  const view = err as { status?: unknown };
  return view.status === 422;
}

function queueOrderLabelSpec(position: number): QueueLabelSpec {
  return {
    name: queueOrderLabel(position),
    color: QUEUE_ORDER_LABEL_COLOR,
    description: `Factory queue position ${position}`,
  };
}

function orderedCandidates(lane: string, issues: QueueIssue[]): QueueIssue[] {
  const positions = new Map<number, number>();
  const candidates = issues.map((issue) => {
    const orderLabels = issue.labels.filter((label) => label.startsWith(QUEUE_ORDER_LABEL_PREFIX));
    if (orderLabels.length !== 1) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} must have exactly one queue order label`,
      );
    }

    const positionText = orderLabels[0].slice(QUEUE_ORDER_LABEL_PREFIX.length);
    if (!/^[1-9]\d*$/.test(positionText)) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} has malformed queue order label ${orderLabels[0]}`,
      );
    }
    const position = Number(positionText);
    if (!Number.isSafeInteger(position)) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issue #${issue.number} has malformed queue order label ${orderLabels[0]}`,
      );
    }
    const priorIssue = positions.get(position);
    if (priorIssue !== undefined) {
      throw new Error(
        `invalid GitHub queue state for lane ${lane}: issues #${priorIssue} and #${issue.number} both have position ${position}`,
      );
    }
    positions.set(position, issue.number);
    return { issue, position };
  });

  return candidates.sort((a, b) => a.position - b.position).map(({ issue }) => issue);
}

export function createOctokitQueueClient(octokit: Octokit): QueueGitHubClient {
  return {
    async listOpenIssuesWithLabels({ owner, repo, labels }) {
      const { data } = await octokit.rest.issues.listForRepo({
        owner,
        repo,
        state: 'open',
        labels: labels.join(','),
        per_page: 100,
      });
      return data
        .filter((issue: { pull_request?: unknown }) => !issue.pull_request)
        .map((issue: { number: number; labels: Array<string | { name?: string }> }) => ({
          number: issue.number,
          labels: (issue.labels ?? [])
            .map((label) => (typeof label === 'string' ? label : (label.name ?? '')))
            .filter((name) => name !== ''),
        }));
    },
    async getIssueLabels({ owner, repo, issue_number }) {
      const { data } = await octokit.rest.issues.listLabelsOnIssue({ owner, repo, issue_number, per_page: 100 });
      return data.map((label) => label.name);
    },
    async addLabels({ owner, repo, issue_number, labels }) {
      await octokit.rest.issues.addLabels({ owner, repo, issue_number, labels });
    },
    async removeLabel({ owner, repo, issue_number, name }) {
      await octokit.rest.issues.removeLabel({ owner, repo, issue_number, name });
    },
    async ensureLabel({ owner, repo, name, color, description }) {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, name, color, description });
      } catch (err) {
        if (labelExistsError(err)) return;
        throw err;
      }
    },
  };
}

export type QueueReleaseOutcome = 'queued' | 'parked' | 'done';

export interface GithubQueueOptions {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  /** Defaults to defaultClaimantId(). Injectable so tests can simulate distinct claimants. */
  claimantId?: string;
  /** Cheap GitHub/git evidence gathered before the label-CAS claim. */
  preflight?: QueuePreflight;
}

export interface GithubQueue {
  claimNext(lane: string): Promise<QueueClaim | null>;
  release(issue: number, outcome?: QueueReleaseOutcome): Promise<void>;
  list(lane: string): Promise<number[]>;
  lanes(): Promise<string[]>;
  migrateLocalQueue(entries: readonly QueueEntry[]): Promise<void>;
}

export function createGithubQueue(options: GithubQueueOptions): GithubQueue {
  const { client, owner, repo } = options;
  const claimantId = options.claimantId ?? defaultClaimantId();
  const myLabel = claimedByLabel(claimantId);
  const ensuredLanes = new Set<string>();
  const deferred = new Set<number>();

  async function ensureLabels(lane: string): Promise<void> {
    if (ensuredLanes.has(lane)) return;
    for (const spec of queueLabelSpecs(lane, claimantId)) {
      await client.ensureLabel({ owner, repo, ...spec });
    }
    ensuredLanes.add(lane);
  }

  async function candidatesFor(lane: string): Promise<QueueIssue[]> {
    return client.listOpenIssuesWithLabels({ owner, repo, labels: [QUEUED_LABEL, laneLabel(lane)] });
  }

  async function list(lane: string): Promise<number[]> {
    const issues = await candidatesFor(lane);
    return orderedCandidates(lane, issues).map((issue) => issue.number);
  }

  async function claimNext(lane: string): Promise<QueueClaim | null> {
    const routeLabel = laneLabel(lane);
    const candidates = orderedCandidates(lane, await candidatesFor(lane));
    if (candidates.length === 0) return null;

    await ensureLabels(lane);

    for (const candidate of candidates) {
      if (deferred.has(candidate.number) || candidate.labels.includes(IN_PROGRESS_LABEL)) {
        deferred.add(candidate.number);
        continue;
      }
      const decision = (await options.preflight?.(candidate)) ?? { kind: 'build' as const };
      if (decision.kind === 'defer') {
        deferred.add(candidate.number);
        continue;
      }
      const latest = await client.getIssueLabels({ owner, repo, issue_number: candidate.number });
      const stillEligible =
        latest.includes(QUEUED_LABEL) &&
        latest.includes(routeLabel) &&
        !latest.includes(IN_PROGRESS_LABEL) &&
        !latest.some((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX));
      if (!stillEligible) {
        deferred.add(candidate.number);
        continue;
      }
      await client.addLabels({ owner, repo, issue_number: candidate.number, labels: [IN_PROGRESS_LABEL, myLabel] });
      const after = await client.getIssueLabels({ owner, repo, issue_number: candidate.number });
      const claims = after.filter((name) => name.startsWith(CLAIMED_BY_LABEL_PREFIX)).sort();
      if (claims.length > 0 && claims[0] === myLabel) {
        await client.removeLabel({ owner, repo, issue_number: candidate.number, name: QUEUED_LABEL });
        return { issue: candidate.number, decision };
      }
      if (after.includes(myLabel)) {
        await client.removeLabel({ owner, repo, issue_number: candidate.number, name: myLabel });
      }
    }
    return null;
  }

  async function release(issue: number, outcome: QueueReleaseOutcome = 'queued'): Promise<void> {
    const current = await client.getIssueLabels({ owner, repo, issue_number: issue });
    const toRemove = current.filter(
      (name) =>
        name === IN_PROGRESS_LABEL ||
        name.startsWith(CLAIMED_BY_LABEL_PREFIX) ||
        (outcome !== 'queued' && (name === QUEUED_LABEL || name.startsWith(QUEUE_ORDER_LABEL_PREFIX))),
    );
    for (const name of toRemove) {
      await client.removeLabel({ owner, repo, issue_number: issue, name });
    }

    if (outcome === 'done') return;

    const target = outcome === 'parked' ? PARKED_LABEL : QUEUED_LABEL;
    if (!current.includes(target)) {
      const spec = queueLabelSpecs('release', claimantId).find((s) => s.name === target);
      if (spec) {
        await client.ensureLabel({ owner, repo, ...spec });
      }
      await client.addLabels({ owner, repo, issue_number: issue, labels: [target] });
    }
  }

  async function lanes(): Promise<string[]> {
    const issues = await client.listOpenIssuesWithLabels({ owner, repo, labels: [QUEUED_LABEL] });
    const found = new Set<string>();
    for (const issue of issues) {
      for (const label of issue.labels) {
        if (label.startsWith(LANE_LABEL_PREFIX)) {
          const slug = label.slice(LANE_LABEL_PREFIX.length);
          if (slug !== '') found.add(slug);
        }
      }
    }
    return [...found].sort();
  }

  async function migrateLocalQueue(entries: readonly QueueEntry[]): Promise<void> {
    const positionsByLane = new Map<string, number>();
    for (const entry of entries) {
      const routeLabel = laneLabel(entry.lane);
      const position = (positionsByLane.get(routeLabel) ?? 0) + 1;
      positionsByLane.set(routeLabel, position);

      const specs: QueueLabelSpec[] = [
        { name: QUEUED_LABEL, color: QUEUED_LABEL_COLOR, description: 'Eligible to be claimed by a factory lane' },
        { name: routeLabel, color: LANE_LABEL_COLOR, description: `Routed to factory lane ${entry.lane}` },
        queueOrderLabelSpec(position),
      ];
      for (const spec of specs) {
        await client.ensureLabel({ owner, repo, ...spec });
      }
      await client.addLabels({
        owner,
        repo,
        issue_number: entry.issue,
        labels: specs.map((spec) => spec.name),
      });
    }
  }

  return { claimNext, release, list, lanes, migrateLocalQueue };
}
