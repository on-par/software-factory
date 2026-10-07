// src/steward/run.ts — run the steward (packet → diagnose → comment) for one stuck parked run (#2124, ADR-0155)
import type { AdrRelevanceCandidate } from '../adr/relevance.js';
import { publishStewardComment, type PublishStewardCommentResult, type StewardCommentGitHubClient } from './comment.js';
import type { StuckDetection } from './detect.js';
import {
  diagnoseStewardPacket,
  type StewardModelInvoker,
  type StewardRouteConfig,
  type StewardVerdictRecord,
} from './diagnose.js';
import { buildStewardPacket, type StewardIssueInput } from './packet.js';

/** Effectful seams the steward needs; injected by the caller (ADR-0004). */
export interface RunStewardPorts {
  /** Run directory: steward-packet.json and steward-verdict.json are written here, and the latest check-r<N> logs are read from here. */
  runDir: string;
  /** costs.jsonl path for the steward cost row. */
  costsFile: string;
  invoke: StewardModelInvoker;
  comments: StewardCommentGitHubClient;
  /** Default: defaultRoutesConfig.routes.steward (diagnoseStewardPacket's default). */
  route?: StewardRouteConfig;
  adrCandidates?: readonly AdrRelevanceCandidate[];
}

export interface RunStewardInput {
  runId: string;
  /** `owner/name`. */
  repo: string;
  issue: StewardIssueInput;
  stuck: StuckDetection;
  /** Frozen spec path; default is buildStewardPacket's own default. */
  planPath?: string;
}

export interface RunStewardResult {
  verdict: StewardVerdictRecord;
  /** Absent when the verdict is a steward-error (nothing renderable). */
  comment?: PublishStewardCommentResult;
}

/** Build the packet, make the one tool-less diagnosis call, and upsert the issue comment. No containment: file or GitHub failures propagate. */
export async function runSteward(input: RunStewardInput, ports: RunStewardPorts): Promise<RunStewardResult> {
  const packet = await buildStewardPacket(ports.runDir, input.issue, {
    ...(input.planPath !== undefined ? { planPath: input.planPath } : {}),
    ...(ports.adrCandidates !== undefined ? { adrCandidates: ports.adrCandidates } : {}),
  });
  const verdict = await diagnoseStewardPacket(ports.runDir, packet, {
    invoke: ports.invoke,
    costsFile: ports.costsFile,
    ...(ports.route !== undefined ? { route: ports.route } : {}),
  });
  if (verdict.reason === 'steward-error') return { verdict };
  const [owner, repo] = input.repo.split('/');
  const comment = await publishStewardComment(ports.comments, {
    owner,
    repo,
    issue: input.issue.number,
    verdict,
    trigger: input.stuck.trigger,
    runId: input.runId,
    signature: input.stuck.failureSignature ?? input.stuck.trigger,
  });
  return { verdict, comment };
}
