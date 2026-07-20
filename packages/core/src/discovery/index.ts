// src/discovery/index.ts — Read-only discovery scan: rank candidate ideas from product signals
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { z } from 'zod';

import { ConstitutionLoader } from '../constitutions/index.js';
import type { CommandResult } from '../utils/command-runner.js';
import { runCommand } from '../utils/command-runner.js';

export type DiscoverySignalSource = 'constitution' | 'roadmap' | 'code-todo' | 'feedback' | 'bug-theme';

export interface DiscoverySignal {
  source: DiscoverySignalSource;
  /** Where the signal came from, e.g. "packages/x/y.ts:42", "ROADMAP.md", ".factory/fingerprints.json" */
  reference: string;
  /** The signal text, trimmed to a single line. */
  detail: string;
  /** Recurrence count; only meaningful for 'bug-theme'. Defaults to 1. */
  count?: number;
}

export interface DiscoveryCandidate {
  /** One-line hypothesis. */
  hypothesis: string;
  /** Ranking score; higher = more compelling. */
  score: number;
  /** The concrete signals that motivated this idea. ALWAYS length >= 1. */
  signals: DiscoverySignal[];
}

export interface DiscoveryScanResult {
  scannedAt: string; // ISO timestamp from deps.now()
  repoDir: string;
  signalsCollected: number; // total signals read across all sources (pre-capping)
  candidates: DiscoveryCandidate[]; // ranked desc, length <= resolved cap
}

export interface DiscoveryScanOptions {
  repoDir: string;
  /** Max candidates per cycle. Falls back to DEFAULT_MAX_CANDIDATES (5) when omitted. */
  maxCandidates?: number;
}

export interface DiscoveryScanDeps {
  now?: () => Date;
  /** Runs a read-only external command (only used for `gh issue list`). Defaults to runCommand. */
  run?: (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>;
}

export const DEFAULT_MAX_CANDIDATES = 5;

const SOURCE_WEIGHT: Record<DiscoverySignalSource, number> = {
  'bug-theme': 5,
  roadmap: 4,
  feedback: 3,
  'code-todo': 2,
  constitution: 2,
};

// Source priority for deterministic tie-breaking (higher first):
const SOURCE_PRIORITY: Record<DiscoverySignalSource, number> = {
  'bug-theme': 4,
  roadmap: 3,
  feedback: 2,
  'code-todo': 1,
  constitution: 0,
};

const MAX_SCANNED_FILES = 2000; // guard against huge trees
const MAX_FILE_BYTES = 512 * 1024; // skip large files
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.factory', 'coverage', '.turbo']);
const TODO_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.md', '.mjs', '.cjs']);
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'your',
  'our',
  'are',
  'was',
  'will',
  'when',
  'then',
  'than',
  'have',
  'has',
  'not',
  'but',
  'all',
  'any',
  'can',
  'use',
  'add',
  'fix',
  'via',
]);

const FingerprintThemeSchema = z.object({ key: z.string(), label: z.string(), count: z.number() });
const FingerprintsSchema = z.object({ themes: z.array(FingerprintThemeSchema).default([]) });

// ---------- Token helpers ----------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function significantTokens(text: string): string[] {
  return tokenize(text).filter((token) => token.length >= 4 && !STOPWORDS.has(token));
}

function sharesSignificantToken(detail: string, titles: string[]): boolean {
  const detailTokens = new Set(significantTokens(detail));
  if (detailTokens.size === 0) return false;
  for (const title of titles) {
    for (const token of significantTokens(title)) {
      if (detailTokens.has(token)) return true;
    }
  }
  return false;
}

function northStarKeywords(signals: DiscoverySignal[]): Set<string> {
  const keywords = new Set<string>();
  for (const signal of signals) {
    for (const token of tokenize(signal.detail)) {
      if (token.length >= 4 && !STOPWORDS.has(token)) keywords.add(token);
    }
  }
  return keywords;
}

// ---------- Reader helpers ----------

function collectConstitutionSignals(repoDir: string): DiscoverySignal[] {
  let constitution;
  try {
    constitution = new ConstitutionLoader().loadFromRepo(repoDir);
  } catch {
    return [];
  }
  if (!constitution) return [];
  const reference = constitution.source === 'repo' ? 'CLAUDE.md' : constitution.path;
  const signals: DiscoverySignal[] = [];
  const headingRe = /^#{1,6}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headingRe.exec(constitution.body)) !== null) {
    signals.push({ source: 'constitution', reference, detail: match[1].trim() });
  }
  return signals;
}

function readFirstExisting(repoDir: string, relPaths: string[]): { relPath: string; content: string } | null {
  for (const relPath of relPaths) {
    try {
      const content = readFileSync(join(repoDir, relPath), 'utf-8');
      return { relPath, content };
    } catch {
      continue;
    }
  }
  return null;
}

function parseListItems(content: string): string[] {
  const items: string[] = [];
  for (const line of content.split('\n')) {
    const bulletMatch = /^\s*[-*]\s+(.+)$/.exec(line);
    const numberedMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
    const raw = bulletMatch?.[1] ?? numberedMatch?.[1];
    if (!raw) continue;
    const stripped = raw.replace(/^\[[ xX]\]\s*/, '').trim();
    if (stripped) items.push(stripped);
  }
  return items;
}

function collectRoadmapSignals(repoDir: string): DiscoverySignal[] {
  const found = readFirstExisting(repoDir, ['ROADMAP.md', 'docs/ROADMAP.md']);
  if (!found) return [];
  return parseListItems(found.content).map((detail) => ({
    source: 'roadmap' as const,
    reference: found.relPath,
    detail,
  }));
}

function collectFeedbackSignals(repoDir: string): DiscoverySignal[] {
  const found = readFirstExisting(repoDir, ['FEEDBACK.md', '.factory/feedback.md']);
  if (!found) return [];
  return parseListItems(found.content).map((detail) => ({
    source: 'feedback' as const,
    reference: found.relPath,
    detail,
  }));
}

function collectTodoSignals(repoDir: string): DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];
  let filesScanned = 0;

  function walk(dir: string): void {
    if (filesScanned >= MAX_SCANNED_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (filesScanned >= MAX_SCANNED_FILES) return;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TODO_EXTS.has(extname(entry.name))) continue;
      const fullPath = join(dir, entry.name);
      filesScanned += 1;
      let size: number;
      try {
        size = statSync(fullPath).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = readFileSync(fullPath, 'utf-8');
      } catch {
        continue;
      }
      const relPath = relative(repoDir, fullPath);
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const match = /\b(?:TODO|FIXME)\b[:\s-]*(.*)/.exec(lines[i]);
        const detail = match?.[1]?.trim();
        if (!detail) continue;
        signals.push({ source: 'code-todo', reference: `${relPath}:${i + 1}`, detail });
      }
    }
  }

  try {
    walk(repoDir);
  } catch {
    return [];
  }

  return signals.sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
}

function collectBugThemeSignals(repoDir: string): DiscoverySignal[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoDir, '.factory', 'fingerprints.json'), 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = FingerprintsSchema.safeParse(parsed);
  if (!result.success) return [];
  return result.data.themes
    .filter((theme) => theme.count >= 2)
    .map((theme) => ({
      source: 'bug-theme' as const,
      reference: '.factory/fingerprints.json',
      detail: theme.label,
      count: theme.count,
    }));
}

async function collectOpenIssueTitles(
  repoDir: string,
  run: (argv: readonly string[], opts: { cwd: string }) => Promise<Pick<CommandResult, 'stdout' | 'ok'>>,
): Promise<string[]> {
  const r = await run(['gh', 'issue', 'list', '--state', 'open', '--limit', '100', '--json', 'title'], {
    cwd: repoDir,
  });
  if (!r.ok) return [];
  try {
    const parsed: unknown = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<{ title?: unknown }>)
      .map((item) => item.title)
      .filter((title): title is string => typeof title === 'string');
  } catch {
    return [];
  }
}

// ---------- Candidate building ----------

function buildHypothesis(signal: DiscoverySignal): string {
  switch (signal.source) {
    case 'code-todo':
      return `Resolve TODO in ${signal.reference}: ${signal.detail}`;
    case 'roadmap':
      return `Advance roadmap item: ${signal.detail}`;
    case 'feedback':
      return `Act on user feedback: ${signal.detail}`;
    case 'bug-theme':
      return `Harden against recurring failures: ${signal.detail} (seen ${signal.count ?? 1}×)`;
    case 'constitution':
      throw new Error('constitution signals do not generate candidates directly');
  }
}

function makeCandidate(
  signal: DiscoverySignal,
  keywords: Set<string>,
  constitutionSignal: DiscoverySignal | undefined,
): DiscoveryCandidate {
  const matchesNorthStar =
    constitutionSignal !== undefined && tokenize(signal.detail).some((token) => keywords.has(token));
  const base = SOURCE_WEIGHT[signal.source];
  const recurrence = signal.source === 'bug-theme' ? Math.min(5, Math.max(0, (signal.count ?? 1) - 1)) : 0;
  const northStar = matchesNorthStar ? 2 : 0;
  const signals = [signal];
  if (matchesNorthStar && constitutionSignal) signals.push(constitutionSignal);
  return {
    hypothesis: buildHypothesis(signal),
    score: base + recurrence + northStar,
    signals,
  };
}

function compareCandidates(a: DiscoveryCandidate, b: DiscoveryCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const aPrimary = a.signals[0];
  const bPrimary = b.signals[0];
  const priorityDiff = SOURCE_PRIORITY[bPrimary.source] - SOURCE_PRIORITY[aPrimary.source];
  if (priorityDiff !== 0) return priorityDiff;
  if (aPrimary.reference !== bPrimary.reference) return aPrimary.reference < bPrimary.reference ? -1 : 1;
  if (a.hypothesis !== b.hypothesis) return a.hypothesis < b.hypothesis ? -1 : 1;
  return 0;
}

// ---------- Main entry point ----------

export async function runDiscoveryScan(
  options: DiscoveryScanOptions,
  deps: DiscoveryScanDeps = {},
): Promise<DiscoveryScanResult> {
  const now = deps.now ?? (() => new Date());
  const run = deps.run ?? ((argv: readonly string[], o: { cwd: string }) => runCommand(argv, { cwd: o.cwd }));
  const cap = Math.max(0, Math.floor(options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const { repoDir } = options;

  const constitutionSignals = collectConstitutionSignals(repoDir);
  const roadmapSignals = collectRoadmapSignals(repoDir);
  const todoSignals = collectTodoSignals(repoDir);
  const feedbackSignals = collectFeedbackSignals(repoDir);
  const bugThemeSignals = collectBugThemeSignals(repoDir);
  const openIssueTitles = await collectOpenIssueTitles(repoDir, run);

  const signalsCollected =
    constitutionSignals.length +
    roadmapSignals.length +
    todoSignals.length +
    feedbackSignals.length +
    bugThemeSignals.length;

  const keywords = northStarKeywords(constitutionSignals);
  const constitutionSignal = constitutionSignals[0];

  const generatingSignals = [...roadmapSignals, ...todoSignals, ...feedbackSignals, ...bugThemeSignals];

  const candidates = generatingSignals
    .filter((signal) => !sharesSignificantToken(signal.detail, openIssueTitles))
    .map((signal) => makeCandidate(signal, keywords, constitutionSignal))
    .sort(compareCandidates);

  return {
    scannedAt: now().toISOString(),
    repoDir,
    signalsCollected,
    candidates: candidates.slice(0, cap),
  };
}
