// src/kpis/classifier-outcomes.ts — Join shadow PR classifier verdicts to human actions and post-merge outcomes (#1726)

import type { ReviewClass } from '../review/floor.js';
import type { FactoryEvent } from '../types/index.js';
import { isDefectWindowClosed } from './defects.js';
import type { PrSource } from './human.js';

export type ClassifierOutcomeVerdict = 'agree' | 'disagree' | 'pending';

export interface ClassifierOutcomeRecord {
  issue: string;
  prNumber: number;
  /** ts of the pr-classified event that was joined. */
  classifiedAt: string;
  /** The shadow class being judged. */
  modelClass: ReviewClass;
  floorClass: ReviewClass | null;
  finalClass: ReviewClass | null;
  model: string | null;
  promptVersion: string;
  policyVersion: string;
  diffSha: string | null;
  humanApproved: boolean;
  /** A human-edited event at or before mergedAt (any time when unmerged). */
  humanEdited: boolean;
  /** PrSource.closedAt !== null (closed without merge). */
  humanAbandoned: boolean;
  merged: boolean;
  mergedAt: string | null;
  defectWindowClosed: boolean;
  /** A post-merge-defect event exists for the issue; counted only once the window has closed. */
  defectFired: boolean;
  verdict: ClassifierOutcomeVerdict;
  /** True only for modelClass A that met a defect. */
  slipped: boolean;
}

interface OutcomeFacts {
  humanEdited: boolean;
  humanAbandoned: boolean;
  merged: boolean;
  defectWindowClosed: boolean;
  defectFired: boolean;
}

function decideVerdict(cls: ReviewClass, facts: OutcomeFacts): { verdict: ClassifierOutcomeVerdict; slipped: boolean } {
  const escalated = cls === 'A';
  if (facts.humanAbandoned && !facts.merged) {
    return { verdict: escalated ? 'disagree' : 'agree', slipped: false };
  }
  if (!facts.merged || !facts.defectWindowClosed) return { verdict: 'pending', slipped: false };
  if (facts.defectFired) {
    return { verdict: escalated ? 'disagree' : 'agree', slipped: escalated };
  }
  if (facts.humanEdited) return { verdict: escalated ? 'disagree' : 'agree', slipped: false };
  return { verdict: escalated ? 'agree' : 'disagree', slipped: false };
}

export function joinClassifierOutcomes(
  events: FactoryEvent[],
  sources: PrSource[],
  opts: { now: string; windowDays: number },
): ClassifierOutcomeRecord[] {
  const latest = new Map<string, FactoryEvent>();
  for (const e of events) {
    if (e.type !== 'pr-classified' || !/^\d+$/.test(e.issue)) continue;
    if (!e.prClassification || e.prClassification.modelClass === null) continue;
    const prev = latest.get(e.issue);
    if (!prev || Date.parse(e.ts) >= Date.parse(prev.ts)) latest.set(e.issue, e);
  }

  const sourceByIssue = new Map<string, PrSource>();
  for (const s of sources) {
    const prev = sourceByIssue.get(s.issue);
    if (!prev || s.prNumber > prev.prNumber) sourceByIssue.set(s.issue, s);
  }

  const issues = [...latest.keys()].sort((a, b) => Number(a) - Number(b));
  const records: ClassifierOutcomeRecord[] = [];
  for (const issue of issues) {
    const source = sourceByIssue.get(issue);
    if (!source) continue;
    const event = latest.get(issue)!;
    const cls = event.prClassification!;
    const modelClass = cls.modelClass as ReviewClass;
    const mine = events.filter((e) => e.issue === issue);
    const merged = source.mergedAt !== null;
    const mergedMs = source.mergedAt === null ? null : Date.parse(source.mergedAt);
    const humanEdited = mine.some(
      (e) => e.type === 'human-edited' && (mergedMs === null || Date.parse(e.ts) <= mergedMs),
    );
    const defectWindowClosed =
      source.mergedAt !== null && isDefectWindowClosed(source.mergedAt, opts.now, opts.windowDays);
    const defectFired = defectWindowClosed && mine.some((e) => e.type === 'post-merge-defect');
    const humanAbandoned = source.closedAt !== null;
    const { verdict, slipped } = decideVerdict(modelClass, {
      humanEdited,
      humanAbandoned,
      merged,
      defectWindowClosed,
      defectFired,
    });
    records.push({
      issue,
      prNumber: source.prNumber,
      classifiedAt: event.ts,
      modelClass,
      floorClass: cls.floorClass,
      finalClass: cls.finalClass,
      model: cls.model,
      promptVersion: cls.promptVersion,
      policyVersion: cls.policyVersion,
      diffSha: cls.diffSha,
      humanApproved: mine.some((e) => e.type === 'human-approved'),
      humanEdited,
      humanAbandoned,
      merged,
      mergedAt: source.mergedAt,
      defectWindowClosed,
      defectFired,
      verdict,
      slipped,
    });
  }
  return records;
}

function parseLine(line: string): ClassifierOutcomeRecord | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object' && typeof parsed.prNumber === 'number') {
      return parsed as ClassifierOutcomeRecord;
    }
  } catch {
    // fall through
  }
  return null;
}

export function parseClassifierOutcomes(text: string): ClassifierOutcomeRecord[] {
  const out: ClassifierOutcomeRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const rec = parseLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

export function mergeClassifierOutcomes(existing: string, records: ClassifierOutcomeRecord[]): string {
  const incoming = new Map<number, ClassifierOutcomeRecord>();
  for (const r of records) incoming.set(r.prNumber, r);

  const consumed = new Set<number>();
  const lines: string[] = [];
  for (const line of existing.split('\n')) {
    if (line.trim() === '') continue;
    const prior = parseLine(line);
    const next = prior ? incoming.get(prior.prNumber) : undefined;
    if (prior && next) {
      consumed.add(prior.prNumber);
      lines.push(prior.verdict === 'pending' ? JSON.stringify(next) : line);
    } else {
      lines.push(line);
    }
  }
  for (const [prNumber, r] of incoming) {
    if (!consumed.has(prNumber)) lines.push(JSON.stringify(r));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}
