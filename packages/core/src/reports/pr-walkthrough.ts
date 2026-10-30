// src/reports/pr-walkthrough.ts — the large-PR walkthrough (#3623): a short, deterministic markdown
// digest (intent, how to verify) SHIP embeds in the PR body and the evidence pack when the
// diff vs main has at least `minLines` changed lines AND at least `minFiles` changed files.
//
// Soft by default: a failure is a `warn` event and never parks or blocks merge. Harden it (park SHIP
// when a qualifying PR has no walkthrough) only after it has generated reliably on qualifying PRs for
// a sustained period. Hardening would need a separate config switch and an ADR.

import { defaultPrWalkthrough } from '@on-par/factory-config';

import type { CheckSummary } from '../types/index.js';
import { extractSpecIntent, summarizeIntent } from './pr-body.js';

const MANUAL_KINDS = new Set(['screenshot', 'none']);

export interface WalkthroughThresholds {
  minLines: number;
  minFiles: number;
}

export interface NumstatEntry {
  path: string;
  added: number;
  deleted: number;
}

export interface PrWalkthroughInput {
  /** Frozen spec body with the frontmatter stripped. */
  specBody?: string;
  checkSummary?: CheckSummary;
}

export function resolveWalkthroughThresholds(overrides?: Partial<WalkthroughThresholds>): WalkthroughThresholds {
  return {
    minLines: overrides?.minLines ?? defaultPrWalkthrough.minLines,
    minFiles: overrides?.minFiles ?? defaultPrWalkthrough.minFiles,
  };
}

/** Parses `git diff --numstat` output; binary (`-`) and non-numeric counts count as 0 lines. */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    entries.push({ path: parts.slice(2).join('\t'), added: toCount(parts[0]), deleted: toCount(parts[1]) });
  }
  return entries;
}

export function meetsWalkthroughThreshold(entries: NumstatEntry[], thresholds: WalkthroughThresholds): boolean {
  const lines = entries.reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
  return entries.length >= thresholds.minFiles && lines >= thresholds.minLines;
}

export function renderPrWalkthrough(input: PrWalkthroughInput): string {
  const intent = input.specBody === undefined ? {} : extractSpecIntent(input.specBody);
  const summary = summarizeIntent(intent);
  const checks = input.checkSummary;
  const manual = (checks?.results ?? [])
    .flatMap((result) => result.evidencePlanResults ?? [])
    .filter((result) => MANUAL_KINDS.has(result.kind));

  return [
    '### Intent',
    summary ?? '- No spec goal recorded.',
    '',
    '### How to verify',
    '#### Automated',
    checks ? `- Checkers: ${checks.passes} pass, ${checks.failures} fail, ${checks.skips} skip` : '- Checkers: not run',
    '',
    '#### Manual',
    manual.length > 0 ? `- Manual evidence: ${manual.length} recorded.` : '- None recorded.',
  ].join('\n');
}

function toCount(value: string): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}
