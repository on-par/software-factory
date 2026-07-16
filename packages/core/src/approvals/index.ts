// src/approvals/index.ts — ApprovalGate seam + file-based transport (.factory/approvals/)
// Transport v1 is a file handshake: <id>.request.json is written by the pipeline,
// <id>.response.json is written by a responder (TUI). A future socket/IPC transport
// only needs to implement ApprovalGate.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { CheckSummary } from '../types/index.js';

export interface ApprovalRequest {
  id: string;
  issue: number;
  branch: string;
  worktree: string;
  /** Output of `git diff --stat origin/main...HEAD` (may be ''). */
  diffStat: string;
  checkSummary?: CheckSummary;
  requestedAt: string; // ISO
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
  respondedAt: string; // ISO
}

/** The seam. SHIP calls this; any transport can implement it. */
export type ApprovalGate = (req: Omit<ApprovalRequest, 'id' | 'requestedAt'>) => Promise<ApprovalResponse>;

export interface FileApprovalGateOptions {
  dir: string; // paths.approvals
  timeoutMs: number; // fail-safe deny after this long
  pollMs?: number; // default 500; tests pass ~10
}

const REQUEST_SUFFIX = '.request.json';
const RESPONSE_SUFFIX = '.response.json';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFileApprovalGate(opts: FileApprovalGateOptions): ApprovalGate {
  const { dir, timeoutMs, pollMs = 500 } = opts;

  return async (req) => {
    mkdirSync(dir, { recursive: true });
    const id = randomUUID();
    const requestedAt = new Date().toISOString();
    const request: ApprovalRequest = { ...req, id, requestedAt };
    writeFileSync(join(dir, `${id}${REQUEST_SUFFIX}`), JSON.stringify(request, null, 2));

    const responsePath = join(dir, `${id}${RESPONSE_SUFFIX}`);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        try {
          return JSON.parse(readFileSync(responsePath, 'utf-8')) as ApprovalResponse;
        } catch {
          // Partial write shouldn't happen given the atomic rename in
          // respondToApproval, but keep polling defensively.
        }
      }
      await sleep(pollMs);
    }

    return {
      id,
      approved: false,
      reason: `approval timed out after ${Math.round(timeoutMs / 1000)}s`,
      respondedAt: new Date().toISOString(),
    };
  };
}

/** Requests in `dir` that have no matching response file, oldest first. Missing dir → []. Malformed files skipped. */
export function listPendingApprovals(dir: string): ApprovalRequest[] {
  if (!existsSync(dir)) return [];

  const entries = readdirSync(dir);
  const entrySet = new Set(entries);
  const requests: ApprovalRequest[] = [];

  for (const entry of entries) {
    if (!entry.endsWith(REQUEST_SUFFIX)) continue;
    const id = entry.slice(0, -REQUEST_SUFFIX.length);
    if (entrySet.has(`${id}${RESPONSE_SUFFIX}`)) continue;

    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf-8')) as ApprovalRequest;
      requests.push({ ...parsed, id });
    } catch {
      // skip malformed request files
    }
  }

  return requests.sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
}

/** Write <id>.response.json atomically (write to <id>.response.json.tmp, then renameSync). TUI-side helper. */
export function respondToApproval(
  dir: string,
  id: string,
  res: { approved: boolean; reason?: string },
): ApprovalResponse {
  const response: ApprovalResponse = {
    id,
    approved: res.approved,
    reason: res.reason,
    respondedAt: new Date().toISOString(),
  };

  const finalPath = join(dir, `${id}${RESPONSE_SUFFIX}`);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(response, null, 2));
  renameSync(tmpPath, finalPath);
  return response;
}
