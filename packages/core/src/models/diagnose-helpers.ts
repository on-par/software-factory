// src/models/diagnose-helpers.ts — Small pure helpers for diagnoseModels

import type { LocalAuthFailure } from '../utils/local-auth-record.js';

/** Reason shown when an agent's last run hit local_auth and nobody has logged in since (#2733). */
export function localAuthFailureReason(failure: LocalAuthFailure): string {
  return `${failure.agent} failed sign-in (local_auth) on a run at ${failure.at}, with no login since — re-run ${failure.agent === 'opencode' ? 'opencode auth login' : `${failure.agent} login`}`;
}

/** True when OLLAMA_BASE_URL points at a non-loopback host, i.e. the local
 *  `ollama` CLI and `ollama list` are the wrong probes. Unparseable URLs fall
 *  back to local probing. */
export function isRemoteOllamaBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl).hostname;
    return !['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host);
  } catch {
    return false;
  }
}
