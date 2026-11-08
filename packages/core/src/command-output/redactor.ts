// src/command-output/redactor.ts — the one redaction pass command output goes through before it is queued for
// OTLP: known secret values from the environment, then the factory's existing secret pattern sets.

import { parseKeyPairsIntoRecord } from '@opentelemetry/core';

import { isCredentialEnvName } from '../environment/checker-env.js';
import { redactSecrets as redactReportSecrets } from '../filing/redact.js';
import { redactSecrets as redactFailureSecrets } from '../router/failure-detail.js';
import { isGitHubCredentialEnvVar, MIN_SECRET_LENGTH, redactGitHubCredentials } from '../utils/github-credentials.js';
import { LINE_CAP } from './line-framer.js';

const OTLP_HEADERS_ENV = /^OTEL_EXPORTER_OTLP_(?:[A-Z]+_)?HEADERS$/;
const MIN_HOLD_BACK = 1024;
const MAX_HOLD_BACK = LINE_CAP / 2;

/** A value and each of its whitespace-separated parts, keeping only those long enough to be a secret. */
function withParts(value: string): string[] {
  return [value, ...value.split(/\s+/)].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/** Secret values to mask literally: every credential-like env var (GitHub and generic `*_TOKEN`, `*_API_KEY`,
 *  `*_SECRET`, `*_PASSWORD`, …) and each OTLP header value as the official OTel parser reads it. A value with
 *  whitespace also contributes its parts, so a line cut at that whitespace still masks both halves. */
export function collectKnownSecrets(env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (OTLP_HEADERS_ENV.test(name)) {
      for (const header of Object.values(parseKeyPairsIntoRecord(value))) for (const v of withParts(header)) out.add(v);
    } else if (isGitHubCredentialEnvVar(name) || isCredentialEnvName(name)) {
      for (const v of withParts(value)) out.add(v);
    }
  }
  return [...out];
}

export interface Redactor {
  redact(text: string): string;
  /** Characters a line framer must keep back before a cut: at least the longest known secret, bounded. */
  readonly holdBack: number;
}

/** Masks `known` values (longest first), then GitHub token shapes, then the router and filing pattern sets. */
export function createRedactor(known: readonly string[]): Redactor {
  const values = [...new Set(known)].sort((a, b) => b.length - a.length);
  const longest = values[0]?.length ?? 0;
  return {
    holdBack: Math.min(MAX_HOLD_BACK, Math.max(MIN_HOLD_BACK, longest + 64)),
    redact(text) {
      let t = text;
      for (const v of values) if (t.includes(v)) t = t.split(v).join('[redacted]');
      return redactReportSecrets(redactFailureSecrets(redactGitHubCredentials(t, {})));
    },
  };
}
