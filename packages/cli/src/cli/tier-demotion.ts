// packages/cli/src/cli/tier-demotion.ts — record, apply and acknowledge trust tier demotions (#1959, ADR-0148)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { styleText } from 'node:util';
import type { Octokit } from '@octokit/rest';
import { getFactoryPaths, loadRepoConfig, type FactoryEvent, type RepoFactoryConfig } from '@on-par/factory-core';
import {
  acknowledgeTierDemotions,
  effectiveTrustTier,
  findSlipDemotions,
  parseTierDemotions,
  resolveTrustTier,
  serializeTierDemotions,
  tierDemotionComment,
  type TierDemotionRecord,
  type TrustTier,
} from '@on-par/factory-core/internal';
import { CliExitError } from './errors.js';

function readDemotions(path: string): { records: TierDemotionRecord[]; malformed: number } {
  if (!existsSync(path)) return { records: [], malformed: 0 };
  try {
    return parseTierDemotions(readFileSync(path, 'utf8'));
  } catch {
    return { records: [], malformed: 1 };
  }
}

/** The merge trust tier in force: classifier.trustTier lowered by any unacknowledged demotion, T0 if the file is bad. */
export function resolveEffectiveTrustTier(repo: RepoFactoryConfig | null, path: string): TrustTier {
  return effectiveTrustTier(resolveTrustTier(repo), readDemotions(path));
}

export async function recordTierDemotions(input: {
  path: string;
  events: FactoryEvent[];
  now: string;
  comment: (issue: number, body: string) => Promise<void>;
  warn: (msg: string) => void;
}): Promise<TierDemotionRecord[]> {
  const existing = readDemotions(input.path);
  if (existing.malformed > 0) {
    input.warn(
      `${input.path} is malformed — tier demotions not recorded; the effective trust tier is T0 until it is fixed`,
    );
    return [];
  }
  const fresh = findSlipDemotions(input.events, existing.records, { now: input.now });
  if (fresh.length === 0) return [];
  mkdirSync(dirname(input.path), { recursive: true });
  writeFileSync(input.path, serializeTierDemotions([...existing.records, ...fresh]));
  for (const record of fresh) {
    try {
      await input.comment(record.defectIssue ?? Number(record.issue), tierDemotionComment(record));
    } catch (err) {
      input.warn(
        `tier demotion comment for PR #${record.prNumber} failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return fresh;
}

export function cmdClassifierAckDemotion(deps: {
  path: string;
  configured: TrustTier;
  now: string;
  by: string;
  log: (line: string) => void;
}): TierDemotionRecord[] {
  const existing = readDemotions(deps.path);
  if (existing.malformed > 0) {
    throw new CliExitError(`factory: ${deps.path} is malformed — the effective trust tier is T0 until it is fixed`, 1);
  }
  const { records, acknowledged } = acknowledgeTierDemotions(existing.records, { now: deps.now, by: deps.by });
  if (acknowledged.length === 0) {
    deps.log('No unacknowledged tier demotions.');
    return [];
  }
  writeFileSync(deps.path, serializeTierDemotions(records));
  for (const r of acknowledged) deps.log(`acknowledged PR #${r.prNumber} ${r.from}→${r.to}`);
  deps.log(`effective trust tier: ${deps.configured}`);
  return acknowledged;
}

/** The `factory kpis` binding: record demotions, comment on the defect issue, and print one line per demotion. */
export async function recordKpiTierDemotions(
  path: string,
  events: FactoryEvent[],
  now: string,
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<void> {
  const warn = (m: string) => console.error(styleText('yellow', `factory: ${m}`));
  const comment = async (n: number, body: string) => {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: n, body });
  };
  try {
    const fresh = await recordTierDemotions({ path, events, now, comment, warn });
    for (const r of fresh) warn(`trust tier demoted ${r.from}→${r.to} (PR #${r.prNumber})`);
  } catch (err) {
    warn(`tier demotions not recorded (${err instanceof Error ? err.message : String(err)})`);
  }
}

/** `factory classifier ack-demotion`: acknowledge every open demotion for this repo and print the result. */
export function runAckTierDemotion(
  repoRoot: string = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
  repo: RepoFactoryConfig | null = loadRepoConfig(repoRoot),
): void {
  cmdClassifierAckDemotion({
    path: getFactoryPaths(repoRoot).tierDemotions,
    configured: resolveTrustTier(repo),
    now: new Date().toISOString(),
    by: process.env.USER ?? 'unknown',
    log: console.log,
  });
}
