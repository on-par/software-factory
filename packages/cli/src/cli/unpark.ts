import type { QueueGitHubClient } from '@on-par/factory-core/internal';
import {
  createGithubQueue,
  LANE_LABEL_PREFIX,
  laneLabel,
  PARKED_LABEL,
  QUEUE_ORDER_LABEL_PREFIX,
} from '@on-par/factory-core/internal';

export type UnparkErrorCode = 'not-parked' | 'lane-required' | 'unpark-failed';

export class UnparkError extends Error {
  constructor(
    readonly code: UnparkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnparkError';
  }
}

/** `factory unpark --json` payload (#2277). Additive changes only; bump schemaVersion on a breaking change. */
export interface UnparkJson {
  schemaVersion: 1;
  ok: true;
  action: 'unpark';
  issue: number;
  /** Slug actually routed to (the factory:lane:<slug> suffix). */
  lane: string;
  /** The one order position assigned. */
  order: number;
  labelsBefore: string[];
  labelsAfter: string[];
}

export interface UnparkInput {
  client: QueueGitHubClient;
  owner: string;
  repo: string;
  issue: number;
  lane?: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runUnpark(input: UnparkInput): Promise<UnparkJson> {
  const { client, owner, repo, issue } = input;
  const ref = { owner, repo, issue_number: issue };
  try {
    const labelsBefore = await client.getIssueLabels(ref);
    if (!labelsBefore.includes(PARKED_LABEL)) {
      throw new UnparkError('not-parked', `#${issue} is not labelled ${PARKED_LABEL}`);
    }

    const existing = labelsBefore
      .filter((l) => l.startsWith(LANE_LABEL_PREFIX))
      .map((l) => l.slice(LANE_LABEL_PREFIX.length))
      .filter((s) => s !== '');
    let lane: string;
    if (input.lane !== undefined && input.lane.trim() !== '') {
      lane = laneLabel(input.lane.trim()).slice(LANE_LABEL_PREFIX.length);
    } else if (existing.length === 1) {
      lane = existing[0];
    } else if (existing.length === 0) {
      throw new UnparkError('lane-required', `#${issue} has no ${LANE_LABEL_PREFIX}* label; pass --lane <lane>`);
    } else {
      throw new UnparkError(
        'lane-required',
        `#${issue} has several lane labels (${existing.join(', ')}); pass --lane <lane>`,
      );
    }

    const keepLane = laneLabel(lane);
    for (const name of labelsBefore) {
      if (name.startsWith(QUEUE_ORDER_LABEL_PREFIX) || (name.startsWith(LANE_LABEL_PREFIX) && name !== keepLane)) {
        await client.removeLabel({ ...ref, name });
      }
    }

    const [r] = await createGithubQueue({ client, owner, repo }).enqueue(lane, [issue]);
    if (r === undefined || r.outcome !== 'queued' || r.position === undefined) {
      throw new UnparkError('unpark-failed', r?.detail ?? `enqueue returned ${r?.outcome}`);
    }

    // Remove the parked label last so a failed run can simply be repeated.
    await client.removeLabel({ ...ref, name: PARKED_LABEL });
    const labelsAfter = await client.getIssueLabels(ref);
    return {
      schemaVersion: 1,
      ok: true,
      action: 'unpark',
      issue,
      lane,
      order: r.position,
      labelsBefore: [...labelsBefore],
      labelsAfter,
    };
  } catch (err) {
    if (err instanceof UnparkError) throw err;
    throw new UnparkError('unpark-failed', message(err));
  }
}
