// packages/core/src/run/ci-failure-note.ts — human-readable diagnosis of a parked SHIP CI failure (#3998)

import { redactSecrets } from '../filing/redact.js';
import { CI_EVIDENCE_LIMITS } from '../utils/ci-evidence.js';
import type { CiFailureEvidence } from '../types/index.js';

const list = (values: readonly string[] | undefined): string =>
  values && values.length > 0 ? values.slice(0, CI_EVIDENCE_LIMITS.maxFlagged).join(', ') : 'none flagged';
// Commit values are hex-validated at collection; redactSecrets would mask a 40-hex SHA as a secret-shaped run.
const safe = redactSecrets;

/**
 * Names each failing check with its conclusion, run link, attribution reason and the files and commits its
 * log flagged. Never includes log text. Returns '' when no check failed.
 */
export function renderCiFailureNote(evidence: CiFailureEvidence | undefined): string {
  if (!evidence || evidence.failingChecks.length === 0) return '';
  const lines = ['Failing CI checks:'];
  for (const check of evidence.failingChecks.slice(0, CI_EVIDENCE_LIMITS.maxChecks)) {
    lines.push(safe(`- ${check.name} (${check.conclusion}) — run: ${check.url ?? 'run link unavailable'}`));
    const reason = evidence.attribution?.items.find((i) => i.kind === 'check' && i.ref === check.name)?.reason;
    if (reason) lines.push(safe(`  attribution: ${reason}`));
    const log = evidence.jobLogs?.find((l) => l.name === check.name);
    if (log) {
      lines.push(safe(`  flagged files: ${list(log.files)}`));
      lines.push(`  flagged commits: ${list(log.commits)}`);
    }
  }
  if (evidence.errors && evidence.errors.length > 0)
    lines.push(safe(`Collection errors: ${evidence.errors.join('; ')}`));
  return lines.join('\n');
}
