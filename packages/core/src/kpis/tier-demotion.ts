// src/kpis/tier-demotion.ts — Demote the effective merge trust tier on a slipped defect (#1959, ADR-0148)

import type { TrustTier } from '../config/repo.js';
import type { FactoryEvent } from '../types/index.js';

export interface TierDemotionRecord {
  type: 'tier-demoted';
  from: TrustTier;
  to: TrustTier;
  mergedUnder: TrustTier;
  prNumber: number;
  issue: string;
  defectIssue: number | null;
  signal: string;
  recordedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

/** Must match the `land` message logged by `enforceRiskAtLand` in packages/cli/src/cli/land-risk.ts. */
export const MERGED_UNDER_TIER_PATTERN = /trust tier (T[012]) — eligible for auto-merge/;

const TIERS = new Set(['T0', 'T1', 'T2']);

function isTier(value: unknown): value is TrustTier {
  return typeof value === 'string' && TIERS.has(value);
}

/** The trust tier the issue's PR was last judged auto-merge-eligible under, or null. */
export function mergedUnderTier(events: FactoryEvent[], issue: string): TrustTier | null {
  let found: TrustTier | null = null;
  let foundTs = '';
  for (const event of events) {
    if (event.type !== 'land' || event.issue !== issue) continue;
    const tier = MERGED_UNDER_TIER_PATTERN.exec(event.msg)?.[1];
    if (!isTier(tier)) continue;
    if (found === null || event.ts >= foundTs) {
      found = tier;
      foundTs = event.ts;
    }
  }
  return found;
}

function demoteOnce(tier: TrustTier): TrustTier {
  if (tier === 'T2') return 'T1';
  return 'T0';
}

/** One demotion per PR that slipped a post-merge defect after merging under T1 or T2. */
export function findSlipDemotions(
  events: FactoryEvent[],
  existing: TierDemotionRecord[],
  opts: { now: string },
): TierDemotionRecord[] {
  const seen = new Set(existing.map((r) => r.prNumber));
  const out: TierDemotionRecord[] = [];
  for (const event of events) {
    if (event.type !== 'post-merge-defect' || !/^\d+$/.test(event.issue)) continue;
    const msg = event.msg;
    const pr = /PR #(\d+)/.exec(msg);
    if (!pr) continue;
    const prNumber = Number(pr[1]);
    if (seen.has(prNumber)) continue;
    const issue = event.issue;
    const mergedUnder = mergedUnderTier(events, issue);
    if (mergedUnder !== 'T1' && mergedUnder !== 'T2') continue;
    seen.add(prNumber);
    const ref = /^issue #(\d+) back-references/.exec(msg);
    out.push({
      type: 'tier-demoted',
      from: mergedUnder,
      to: demoteOnce(mergedUnder),
      mergedUnder,
      prNumber,
      issue,
      defectIssue: ref ? Number(ref[1]) : null,
      signal: msg,
      recordedAt: opts.now,
      acknowledgedAt: null,
      acknowledgedBy: null,
    });
  }
  return out.sort((a, b) => a.prNumber - b.prNumber);
}

export function parseTierDemotions(text: string): { records: TierDemotionRecord[]; malformed: number } {
  const records: TierDemotionRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value = JSON.parse(line) as Partial<TierDemotionRecord> | null;
      if (
        value?.type !== 'tier-demoted' ||
        !isTier(value.from) ||
        !isTier(value.to) ||
        typeof value.prNumber !== 'number'
      ) {
        malformed++;
        continue;
      }
      records.push(value as TierDemotionRecord);
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
}

export function serializeTierDemotions(records: TierDemotionRecord[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

/** Fails closed to T0 on a malformed file; one tier below configured while any demotion is unacknowledged. */
export function effectiveTrustTier(
  configured: TrustTier,
  demotions: { records: TierDemotionRecord[]; malformed: number },
): TrustTier {
  if (demotions.malformed > 0) return 'T0';
  if (demotions.records.some((r) => r.acknowledgedAt === null)) return demoteOnce(configured);
  return configured;
}

export function acknowledgeTierDemotions(
  records: TierDemotionRecord[],
  opts: { now: string; by: string },
): { records: TierDemotionRecord[]; acknowledged: TierDemotionRecord[] } {
  const acknowledged: TierDemotionRecord[] = [];
  const next = records.map((r) => {
    if (r.acknowledgedAt !== null) return r;
    const stamped = { ...r, acknowledgedAt: opts.now, acknowledgedBy: opts.by };
    acknowledged.push(stamped);
    return stamped;
  });
  return { records: next, acknowledged };
}

export function tierDemotionComment(record: TierDemotionRecord): string {
  return [
    `<!-- factory:tier-demoted pr=${record.prNumber} -->`,
    `Trust tier demoted ${record.from} → ${record.to}: PR #${record.prNumber} (merged under ${record.mergedUnder}) slipped a post-merge defect (${record.signal}). The configured classifier.trustTier is unchanged; the effective tier stays ${record.to} until a human runs \`factory classifier ack-demotion\` (ADR-0148).`,
  ].join('\n');
}
