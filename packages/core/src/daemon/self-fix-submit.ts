// src/daemon/self-fix-submit.ts — POST /self-fix: resolve the attached repo's filing
// policy and file-or-reuse one guard-labelled self-fix issue for a fingerprint (#1392).

import { getFactoryPaths, loadFactoryConfigForRepo, resolveFilingPolicy } from '../config/index.js';
import type { FilingGitHubClient } from '../filing/index.js';
import { requestSelfFix, type SelfFixResult } from '../filing/self-fix.js';
import type { EvidencePack, FailoverReason, FailureOrigin, FailurePhase } from '../types/index.js';
import { getRepo, loadRegistry } from './registry.js';

export interface DaemonSelfFixDeps {
  client?: FilingGitHubClient;
  now?: () => Date;
}

export type SelfFixFailureReason = 'invalid-request' | 'unknown-repo' | 'not-wired';

export type DaemonSelfFixResult =
  { ok: true; result: SelfFixResult } | { ok: false; reason: SelfFixFailureReason; detail: string };

interface SubmitSelfFixRequest {
  repo: string;
  fingerprint: string;
  runId?: string;
  evidence: EvidencePack;
}

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const FINGERPRINT_RE = /^ff_[0-9a-f]{16}$/;
const PHASES = new Set<FailurePhase>(['plan', 'build', 'check', 'ship']);
const ORIGINS = new Set<FailureOrigin>(['factory-internal', 'product']);

function parseSubmitSelfFixRequest(
  body: unknown,
): { ok: true; request: SubmitSelfFixRequest } | { ok: false; detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { ok: false, detail: 'expected { repo, fingerprint, evidence }' };
  const { repo, fingerprint, runId, evidence } = body as Partial<SubmitSelfFixRequest>;
  if (typeof repo !== 'string' || !SLUG_RE.test(repo))
    return { ok: false, detail: `invalid repo: ${JSON.stringify(repo)}` };
  if (typeof fingerprint !== 'string' || !FINGERPRINT_RE.test(fingerprint))
    return { ok: false, detail: `invalid fingerprint: ${JSON.stringify(fingerprint)}` };
  if (runId !== undefined && typeof runId !== 'string')
    return { ok: false, detail: `invalid runId: ${JSON.stringify(runId)}` };
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence))
    return { ok: false, detail: 'invalid evidence' };
  const candidate = evidence as Partial<EvidencePack>;
  for (const field of ['repo', 'issue', 'model', 'component', 'eventExcerpt', 'logPath'] as const) {
    if (typeof candidate[field] !== 'string') return { ok: false, detail: `invalid evidence.${field}` };
  }
  if (!PHASES.has(candidate.phase as FailurePhase)) return { ok: false, detail: 'invalid evidence.phase' };
  if (!ORIGINS.has(candidate.origin as FailureOrigin)) return { ok: false, detail: 'invalid evidence.origin' };
  if (typeof candidate.reason !== 'string' || candidate.reason.length === 0)
    return { ok: false, detail: 'invalid evidence.reason' };
  return {
    ok: true,
    request: {
      repo,
      fingerprint,
      ...(runId === undefined ? {} : { runId }),
      evidence: {
        ...candidate,
        phase: candidate.phase as FailurePhase,
        origin: candidate.origin as FailureOrigin,
        reason: candidate.reason as FailoverReason,
      } as EvidencePack,
    },
  };
}

export async function submitDaemonSelfFix(
  registryFile: string,
  body: unknown,
  deps: DaemonSelfFixDeps = {},
): Promise<DaemonSelfFixResult> {
  const parsed = parseSubmitSelfFixRequest(body);
  if (!parsed.ok) return { ok: false, reason: 'invalid-request', detail: parsed.detail };
  const { repo, fingerprint, runId, evidence } = parsed.request;
  const entry = getRepo(await loadRegistry(registryFile), repo);
  if (entry === undefined || entry.state === 'detached')
    return { ok: false, reason: 'unknown-repo', detail: `${repo} is not attached` };
  if (deps.client === undefined)
    return { ok: false, reason: 'not-wired', detail: 'no filing client wired into factoryd (#1392)' };
  const policy = resolveFilingPolicy(loadFactoryConfigForRepo(getFactoryPaths(entry.path, entry.stateRoot).config));
  const result = await requestSelfFix(deps.client, {
    fingerprinted: { fingerprint, evidence },
    policy,
    now: deps.now ?? (() => new Date()),
    ...(runId === undefined ? {} : { runId }),
  });
  return { ok: true, result };
}
