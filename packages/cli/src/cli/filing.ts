// packages/cli/src/cli/filing.ts — `factory filing preview <run-id>`: print the redacted upstream report, send nothing (#1858).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { readEvents } from '@on-par/factory-core';
import {
  buildUpstreamReport,
  daemonRunFile,
  isValidRunId,
  readDaemonRun,
  upstreamInputFromEvidence,
} from '@on-par/factory-core/internal';

export interface FilingPreviewDeps {
  out: { write(s: string): unknown };
  err: { write(s: string): unknown };
  eventsFile: string;
  runsDir: string;
  factoryVersion: string;
  factoryCommit: () => Promise<string | null>;
  os: string;
  nodeVersion: string;
  usernames: string[];
  hostnames: string[];
  branchPrefix?: string;
}

type EvidenceEvent = FactoryEvent & { fingerprint: string; evidence: NonNullable<FactoryEvent['evidence']> };

function hasEvidence(e: FactoryEvent): e is EvidenceEvent {
  return typeof e.fingerprint === 'string' && e.evidence !== undefined;
}

/** Print the exact title and body an upstream report would carry. Returns false when no evidence matches. */
export async function runFilingPreview(runId: string, deps: FilingPreviewDeps): Promise<boolean> {
  const events = readEvents(deps.eventsFile).filter(hasEvidence);
  const record = isValidRunId(runId) ? await readDaemonRun(daemonRunFile(deps.runsDir, runId)) : null;
  const matches = record
    ? events.filter((e) => e.issue === String(record.issue) && (!e.repo || e.repo === record.repo))
    : events.filter((e) => e.fingerprint === runId);
  const match = matches[matches.length - 1];
  if (!match) {
    deps.err.write(`No failure evidence found for run ${runId}.\n`);
    return false;
  }

  const repoSlugs = [record?.repo, match.repo].filter((s): s is string => !!s);
  const owners = repoSlugs.map((s) => s.split('/')[0]).filter((s): s is string => !!s);
  const input = upstreamInputFromEvidence(
    { fingerprint: match.fingerprint, evidence: match.evidence },
    {
      factoryVersion: deps.factoryVersion,
      factoryCommit: await deps.factoryCommit(),
      os: deps.os,
      nodeVersion: deps.nodeVersion,
      redaction: {
        repoSlugs,
        usernames: [...deps.usernames, ...owners],
        hostnames: deps.hostnames,
        branchPrefix: deps.branchPrefix,
      },
    },
  );
  const { title, body } = buildUpstreamReport(input);
  deps.out.write(`${title}\n\n${body.replace(/\n+$/, '')}\n`);
  deps.err.write('Preview only — nothing was sent.\n');
  return true;
}

/** Sha of the factory checkout `cwd` sits in; null when installed or not a factory checkout (never the target repo's). */
export async function resolveFactoryCheckoutCommit(
  cwd: string,
  run: (cmd: string, cwd: string) => Promise<string>,
): Promise<string | null> {
  try {
    const top = (await run('git rev-parse --show-toplevel', cwd)).trim();
    const pkg = JSON.parse(readFileSync(resolve(top, 'packages/cli/package.json'), 'utf8')) as { name?: string };
    if (pkg.name !== '@on-par/factory-cli') return null;
    return (await run('git rev-parse HEAD', cwd)).trim() || null;
  } catch {
    return null;
  }
}
