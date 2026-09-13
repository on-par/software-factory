// src/filing/self-fix.ts — Operator-requested self-fix: file or reuse exactly one
// guard-labelled bug issue per fingerprint (#1392). See ADR on why this path is not
// gated by evaluateFilingPolicy.

import type { FingerprintedFailure } from '../types/index.js';
import { type FileBugAction, type FilingGitHubClient, fileBug } from './index.js';
import type { FilingPolicy } from './policy.js';

export interface SelfFixRequest {
  fingerprinted: FingerprintedFailure;
  policy: FilingPolicy;
  now: () => Date;
  runId?: string;
  internalRepo?: string;
}

export interface SelfFixResult {
  action: FileBugAction;
  repo: string;
  issueNumber: number;
  fingerprint: string;
  occurrences: number;
  /** Labels this request guaranteed on the issue; always includes policy.selfFixLabel. */
  labels: string[];
}

/** Base bug labels plus the guard label, deduped and order-stable. */
export function selfFixLabels(policy: FilingPolicy): string[] {
  return [...new Set([...policy.bugLabels, policy.selfFixLabel])];
}

export async function requestSelfFix(client: FilingGitHubClient, request: SelfFixRequest): Promise<SelfFixResult> {
  const labels = selfFixLabels(request.policy);
  const filed = await fileBug(client, {
    fingerprinted: request.fingerprinted,
    now: request.now,
    runId: request.runId,
    internalRepo: request.internalRepo,
    labels,
  });
  if (filed.action === 'bumped') {
    const [owner, repo] = filed.repo.split('/');
    await client.addLabels({
      owner: owner as string,
      repo: repo as string,
      issue_number: filed.issueNumber,
      labels,
    });
  }
  return { ...filed, labels };
}
