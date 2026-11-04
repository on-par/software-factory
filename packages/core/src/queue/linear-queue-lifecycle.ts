// packages/core/src/queue/linear-queue-lifecycle.ts — Linear queue release, park, lease heartbeat and reap (ADR-0173, #3893).
import { z } from 'zod';
import {
  claimedByLabel,
  DEFAULT_CLAIM_LEASE_MS,
  defaultClaimantId,
  PARKED_LABEL,
  type QueueReleaseOutcome,
} from './github-queue.js';
import type { LinearTrackerConfig } from '../config/tracker-section.js';
import { type WorkKey, toWorkKey } from '../work/work-key.js';

export const LINEAR_LEASE_KIND = 'factory-claim-lease';

export interface LinearClaimLease {
  kind: typeof LINEAR_LEASE_KIND;
  claimantId: string;
  /** epoch ms */
  expiresAt: number;
}

export interface LinearIssueLabelRef {
  id: string;
  name: string;
}

export interface LinearClaimedIssue {
  id: string;
  identifier: string;
  labels: LinearIssueLabelRef[];
  /** The factory-owned lease attachment, when present; metadata is untrusted. */
  lease?: { attachmentId: string; metadata: unknown };
}

export interface LinearQueueLifecycleClient {
  findIssue(identifier: string): Promise<LinearClaimedIssue | null>;
  /** Every issue in the mapped project carrying a factory lease attachment. */
  listLeasedIssues(): Promise<LinearClaimedIssue[]>;
  ensureLabel(name: string): Promise<string>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;
  moveToState(issueId: string, stateName: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Creates or replaces the factory lease attachment on the issue with this metadata. */
  upsertLeaseAttachment(issueId: string, lease: LinearClaimLease): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<void>;
}

export interface LinearStaleClaimRelease {
  key: WorkKey;
  claimantId: string;
  expiresAt: number;
  released: boolean;
  outcome: 'released' | 'failed';
  detail?: string;
}

export interface LinearQueueLifecycle {
  release(key: WorkKey, outcome?: QueueReleaseOutcome, reason?: string): Promise<void>;
  heartbeat(key: WorkKey): Promise<boolean>;
  reap(): Promise<LinearStaleClaimRelease[]>;
}

export interface LinearQueueLifecycleOptions {
  client: LinearQueueLifecycleClient;
  linear: LinearTrackerConfig;
  /** Receives one line per failed Linear write; required so a failure is never silent. */
  warn: (msg: string) => void;
  claimantId?: string;
  leaseMs?: number;
  now?: () => number;
}

const LeaseSchema = z.object({
  kind: z.literal(LINEAR_LEASE_KIND),
  claimantId: z.string().min(1),
  expiresAt: z.number(),
});

export function parseLinearClaimLease(metadata: unknown): LinearClaimLease | null {
  const parsed = LeaseSchema.safeParse(metadata);
  return parsed.success ? parsed.data : null;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createLinearQueueLifecycle(options: LinearQueueLifecycleOptions): LinearQueueLifecycle {
  const { client, linear, warn } = options;
  const claimantId = options.claimantId ?? defaultClaimantId();
  const leaseMs = options.leaseMs ?? DEFAULT_CLAIM_LEASE_MS;
  const now = options.now ?? Date.now;
  const me = claimedByLabel(claimantId);
  let lastError: string | undefined;

  async function attempt(op: string, identifier: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      lastError = messageOf(err);
      warn(`linear queue: ${op} on ${identifier} failed: ${lastError}`);
      return false;
    }
  }

  async function freeClaim(
    issue: LinearClaimedIssue,
    claimLabel: string,
    leaseAttachmentId: string | undefined,
  ): Promise<boolean> {
    let ok = true;
    const label = issue.labels.find((l) => l.name === claimLabel);
    if (label)
      ok = (await attempt('claim label removal', issue.identifier, () => client.removeLabel(issue.id, label.id))) && ok;
    if (leaseAttachmentId !== undefined) {
      ok = (await attempt('lease removal', issue.identifier, () => client.deleteAttachment(leaseAttachmentId))) && ok;
    }
    return ok;
  }

  async function release(key: WorkKey, outcome: QueueReleaseOutcome = 'queued', reason?: string): Promise<void> {
    let issue: LinearClaimedIssue | null;
    try {
      issue = await client.findIssue(key);
    } catch (err) {
      warn(`linear queue: release of ${key}: lookup failed: ${messageOf(err)}`);
      return;
    }
    if (!issue) {
      warn(`linear queue: release of ${key}: issue not found`);
      return;
    }
    const target = issue;
    const ownLease = parseLinearClaimLease(target.lease?.metadata)?.claimantId === claimantId;
    const hasLabel = target.labels.some((l) => l.name === me);
    if (!ownLease && !hasLabel) return;
    await freeClaim(target, me, ownLease ? target.lease?.attachmentId : undefined);

    switch (outcome) {
      case 'queued':
        await attempt('move to ready', key, () => client.moveToState(target.id, linear.states.ready));
        break;
      case 'parked': {
        await attempt('parked label', key, async () => {
          const labelId = await client.ensureLabel(PARKED_LABEL);
          await client.addLabel(target.id, labelId);
        });
        const body = reason?.trim() ? `Parked by the factory: ${reason}` : 'Parked by the factory (no reason given).';
        await attempt('park comment', key, () => client.addComment(target.id, body));
        await attempt('move to parked', key, () => client.moveToState(target.id, linear.states.parked));
        break;
      }
      case 'done':
        break;
      default: {
        const _never: never = outcome;
        return _never;
      }
    }
  }

  async function heartbeat(key: WorkKey): Promise<boolean> {
    let issue: LinearClaimedIssue | null;
    try {
      issue = await client.findIssue(key);
    } catch (err) {
      warn(`linear queue: heartbeat of ${key}: lookup failed: ${messageOf(err)}`);
      return true;
    }
    if (!issue || !issue.labels.some((l) => l.name === me)) return false;
    const target = issue;
    await attempt('lease renew', key, () =>
      client.upsertLeaseAttachment(target.id, { kind: LINEAR_LEASE_KIND, claimantId, expiresAt: now() + leaseMs }),
    );
    return true;
  }

  async function reap(): Promise<LinearStaleClaimRelease[]> {
    let issues: LinearClaimedIssue[];
    try {
      issues = await client.listLeasedIssues();
    } catch (err) {
      warn(`linear queue: reap listing failed: ${messageOf(err)}`);
      return [];
    }
    const rows: LinearStaleClaimRelease[] = [];
    for (const issue of issues) {
      if (!issue.lease) continue;
      const lease = parseLinearClaimLease(issue.lease.metadata);
      if (!lease) {
        warn(`linear queue: reap of ${issue.identifier}: malformed lease attachment`);
        continue;
      }
      if (lease.expiresAt > now()) continue;
      lastError = undefined;
      const freed = await freeClaim(issue, claimedByLabel(lease.claimantId), issue.lease.attachmentId);
      const moved = await attempt('move to ready', issue.identifier, () =>
        client.moveToState(issue.id, linear.states.ready),
      );
      const ok = freed && moved;
      rows.push({
        key: toWorkKey(issue.identifier),
        claimantId: lease.claimantId,
        expiresAt: lease.expiresAt,
        released: ok,
        outcome: ok ? 'released' : 'failed',
        ...(ok ? {} : { detail: lastError }),
      });
    }
    return rows;
  }

  return { release, heartbeat, reap };
}
