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

export function decideVerdict(
  cls: ReviewClass,
  facts: OutcomeFacts,
): { verdict: ClassifierOutcomeVerdict; slipped: boolean } {
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

export type ClassifierOutcomeBucket = 'humanGated' | 'mergedClean' | 'slippedDefect' | 'pending';

export interface ClassifierClassStats {
  /** Merged PRs whose defect window has closed (the evidence count n). */
  closed: number;
  /** Closed PRs that met a post-merge defect. */
  slipped: number;
  /** slipped / closed; null when closed is 0. */
  slipRate: number | null;
  /** Rule-of-three 95% upper bound min(1, 3/closed) when slipped is 0 and closed > 0; else null. */
  upperBound: number | null;
}

export interface ClassifierReport {
  total: number;
  confusion: Record<ReviewClass, Record<ClassifierOutcomeBucket, number>>;
  classes: Record<ReviewClass, ClassifierClassStats>;
  floorAgreement: { stricter: number; equal: number; looser: number; noFloor: number };
}

const REPORT_CLASSES: ReviewClass[] = ['A', 'B', 'C'];
const CLASS_RANK: Record<ReviewClass, number> = { A: 0, B: 1, C: 2 };

/** Class-independent outcome of a record, in the same rule order as decideVerdict. */
export function classifierOutcomeBucket(r: ClassifierOutcomeRecord): ClassifierOutcomeBucket {
  if (r.humanAbandoned && !r.merged) return 'humanGated';
  if (!r.merged || !r.defectWindowClosed) return 'pending';
  if (r.defectFired) return 'slippedDefect';
  if (r.humanEdited) return 'humanGated';
  return 'mergedClean';
}

export function summarizeClassifierOutcomes(records: ClassifierOutcomeRecord[]): ClassifierReport {
  const confusion = {} as ClassifierReport['confusion'];
  const classes = {} as ClassifierReport['classes'];
  for (const c of REPORT_CLASSES) {
    confusion[c] = { humanGated: 0, mergedClean: 0, slippedDefect: 0, pending: 0 };
    classes[c] = { closed: 0, slipped: 0, slipRate: null, upperBound: null };
  }
  const floorAgreement = { stricter: 0, equal: 0, looser: 0, noFloor: 0 };
  let total = 0;
  for (const r of records) {
    if (!REPORT_CLASSES.includes(r.modelClass)) continue;
    total++;
    const bucket = classifierOutcomeBucket(r);
    confusion[r.modelClass][bucket]++;
    if (r.merged && r.defectWindowClosed) {
      classes[r.modelClass].closed++;
      if (bucket === 'slippedDefect') classes[r.modelClass].slipped++;
    }
    if (r.floorClass === null || !(r.floorClass in CLASS_RANK)) floorAgreement.noFloor++;
    else if (CLASS_RANK[r.modelClass] > CLASS_RANK[r.floorClass]) floorAgreement.stricter++;
    else if (CLASS_RANK[r.modelClass] === CLASS_RANK[r.floorClass]) floorAgreement.equal++;
    else floorAgreement.looser++;
  }
  for (const c of REPORT_CLASSES) {
    const s = classes[c];
    s.slipRate = s.closed > 0 ? s.slipped / s.closed : null;
    s.upperBound = s.closed > 0 && s.slipped === 0 ? Math.min(1, 3 / s.closed) : null;
  }
  return { total, confusion, classes, floorAgreement };
}

function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(1))}%`;
}

export function formatClassifierReport(report: ClassifierReport): string[] {
  const lines: string[] = [];
  if (report.total === 0) {
    lines.push('No classifier outcomes recorded yet. Run `factory kpis` to record them.');
  }
  lines.push('Shadow class vs outcome:');
  lines.push(
    `${'class'.padEnd(7)}${'human-gated'.padStart(12)}${'merged clean'.padStart(14)}${'slipped defect'.padStart(16)}${'pending'.padStart(9)}`,
  );
  for (const c of REPORT_CLASSES) {
    const row = report.confusion[c];
    lines.push(
      `${c.padEnd(7)}${String(row.humanGated).padStart(12)}${String(row.mergedClean).padStart(14)}${String(row.slippedDefect).padStart(16)}${String(row.pending).padStart(9)}`,
    );
  }
  lines.push('');
  lines.push('Slip bounds (rule of three, 95% upper bound when 0 slips):');
  for (const c of REPORT_CLASSES) {
    const s = report.classes[c];
    const head = `${c}: ${s.closed} closed, ${s.slipped} slipped`;
    if (s.closed === 0 || s.slipRate === null) lines.push(`${head} — slip rate unknown`);
    else if (s.slipped === 0 && s.upperBound !== null) lines.push(`${head} — slip rate ≤ ${pct(s.upperBound)}`);
    else lines.push(`${head} — observed slip rate ${pct(s.slipRate)}`);
  }
  lines.push('');
  const f = report.floorAgreement;
  const compared = f.stricter + f.equal + f.looser;
  const share = (n: number) => (compared === 0 ? 'unknown' : pct(n / compared));
  lines.push(
    `Model vs floor: stricter ${f.stricter} (${share(f.stricter)}), equal ${f.equal} (${share(f.equal)}), looser ${f.looser} (${share(f.looser)}); no floor ${f.noFloor}`,
  );
  return lines;
}
