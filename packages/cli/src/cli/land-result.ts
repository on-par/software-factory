import type { Octokit } from '@octokit/rest';

import { type LandResultJson, landResultJsonSchema } from './land-result-contract.js';

export type LandResultKind = LandResultJson['result'];

export const LAND_EXIT_CHECKS_PENDING = 75;

export type LandSnapshot = {
  headSha: string | null;
  mergeable: LandResultJson['mergeable'];
  pending: string[];
  failed: string[];
};

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

const SNAPSHOT_QUERY = `query LandResultSnapshot($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      headRefOid
      mergeable
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const unknownSnapshot = (): LandSnapshot => ({ headSha: null, mergeable: 'UNKNOWN', pending: [], failed: [] });

const uniqueSorted = (names: Set<string>): string[] => [...names].sort();

export async function readLandSnapshot(
  octokit: Octokit,
  owner: string,
  repoName: string,
  prNumber: number,
): Promise<LandSnapshot> {
  try {
    const data: any = await octokit.graphql(SNAPSHOT_QUERY, { owner, name: repoName, number: prNumber });
    const pr = data?.repository?.pullRequest;
    if (!pr) return unknownSnapshot();
    const pending = new Set<string>();
    const failed = new Set<string>();
    const nodes: any[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    for (const node of nodes) {
      if (node?.__typename === 'CheckRun') {
        if (node.status !== 'COMPLETED') pending.add(node.name);
        else if (FAILED_CONCLUSIONS.has(node.conclusion)) failed.add(node.name);
      } else if (node?.__typename === 'StatusContext') {
        if (node.state === 'PENDING' || node.state === 'EXPECTED') pending.add(node.context);
        else if (node.state === 'FAILURE' || node.state === 'ERROR') failed.add(node.context);
      }
    }
    return {
      headSha: typeof pr.headRefOid === 'string' ? pr.headRefOid : null,
      mergeable: pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN',
      pending: uniqueSorted(pending),
      failed: uniqueSorted(failed),
    };
  } catch {
    return unknownSnapshot();
  }
}

export function buildLandResultJson(result: LandResultKind, prNumber: number, snapshot: LandSnapshot): LandResultJson {
  const { headSha, mergeable } = snapshot;
  if (result === 'checks_failed') {
    return landResultJsonSchema.parse({
      schemaVersion: 1,
      result,
      pr: prNumber,
      headSha,
      failed: snapshot.failed,
      mergeable,
    });
  }
  const pending = result === 'merged' || result === 'closed' ? [] : snapshot.pending;
  return landResultJsonSchema.parse({ schemaVersion: 1, result, pr: prNumber, headSha, pending, mergeable });
}

export function formatLandResultLine(json: LandResultJson): string {
  return JSON.stringify(json);
}

export async function emitLandResult(
  octokit: Octokit,
  owner: string,
  repoName: string,
  result: LandResultKind,
  prNumber: number,
  fallbackHeadSha?: string,
): Promise<void> {
  const snap = await readLandSnapshot(octokit, owner, repoName, prNumber);
  const snapshot = { ...snap, headSha: snap.headSha ?? fallbackHeadSha ?? null };
  console.log(formatLandResultLine(buildLandResultJson(result, prNumber, snapshot)));
}
