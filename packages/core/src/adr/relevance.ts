// src/adr/relevance.ts — pure ranking of Accepted ADRs by relevance to changed paths (#1722).
import type { ActiveAdr } from './index.js';
import { normalizeAdrTitle } from './similarity.js';

export type AdrMatchReason = 'cites-file' | 'cites-dir' | 'keyword';

export interface AdrRelevanceCandidate {
  adr: ActiveAdr;
  /** Raw markdown of the ADR file — scanned for cited paths. */
  text: string;
}

export interface AdrRelevanceMatch {
  adr: ActiveAdr;
  reason: AdrMatchReason;
  /** The changed path that produced the best (highest-tier) match. */
  changedPath: string;
}

const GENERIC_MODULE_NAMES = new Set([
  'index',
  'types',
  'utils',
  'util',
  'test',
  'tests',
  'main',
  'src',
  'lib',
  'core',
  'helpers',
  'constants',
]);

const PATH_TOKEN = /[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+\/?/g;
const FILE_EXTENSION = /\.[A-Za-z0-9]+$/;

export function extractCitedPaths(text: string): { files: string[]; dirs: string[] } {
  const files = new Set<string>();
  const dirs = new Set<string>();

  for (const match of text.matchAll(PATH_TOKEN)) {
    const before = match.index > 0 ? text[match.index - 1] : '';
    if (before === '/' || before === ':') continue;

    const firstSegment = match[0].split('/')[0] ?? '';
    if (firstSegment.includes('.') && !firstSegment.startsWith('.')) continue;

    const cleaned = match[0]
      .replace(/[.,;:)]+$/, '')
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    if (cleaned === '' || !cleaned.includes('/')) continue;

    const last = cleaned.slice(cleaned.lastIndexOf('/') + 1);
    if (FILE_EXTENSION.test(last) && !last.startsWith('.')) {
      files.add(cleaned);
    } else {
      dirs.add(cleaned);
    }
  }

  return { files: [...files], dirs: [...dirs] };
}

function normalizeChangedPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function moduleNameOf(p: string): string {
  const segments = p.split('/');
  const base = segments[segments.length - 1] ?? '';
  let name = base.replace(/\.(test|spec)(\.[^.]+)*$/, '');
  const dot = name.indexOf('.');
  if (dot > 0) name = name.slice(0, dot);
  if (name === 'index') name = segments[segments.length - 2] ?? '';
  return name;
}

function compareForRelevance(a: AdrRelevanceMatch, b: AdrRelevanceMatch): number {
  const an = a.adr.number;
  const bn = b.adr.number;
  if (an !== bn) {
    if (an === undefined) return 1;
    if (bn === undefined) return -1;
    return bn - an;
  }
  return a.adr.path < b.adr.path ? -1 : a.adr.path > b.adr.path ? 1 : 0;
}

const TIER_REASON: Record<number, AdrMatchReason> = { 3: 'cites-file', 2: 'cites-dir', 1: 'keyword' };

export function rankAdrsByRelevance(
  candidates: readonly AdrRelevanceCandidate[],
  changedPaths: readonly string[],
): AdrRelevanceMatch[] {
  const paths = changedPaths.map(normalizeChangedPath).filter((p) => p !== '');
  const tiered: { match: AdrRelevanceMatch; tier: number }[] = [];

  for (const { adr, text } of candidates) {
    const cited = extractCitedPaths(text);
    const paddedTitle = ` ${normalizeAdrTitle(adr.title)} `;
    let bestTier = 0;
    let bestPath = '';

    for (const p of paths) {
      let tier = 0;
      if (cited.files.some((f) => p === f || (f.includes('/') && p.endsWith(`/${f}`)))) {
        tier = 3;
      } else if (cited.dirs.some((d) => p.startsWith(`${d}/`))) {
        tier = 2;
      } else {
        const normModule = normalizeAdrTitle(moduleNameOf(p));
        if (
          normModule.length >= 3 &&
          !GENERIC_MODULE_NAMES.has(normModule) &&
          paddedTitle.includes(` ${normModule} `)
        ) {
          tier = 1;
        }
      }
      if (tier > bestTier) {
        bestTier = tier;
        bestPath = p;
      }
    }

    const reason = TIER_REASON[bestTier];
    if (reason !== undefined) tiered.push({ match: { adr, reason, changedPath: bestPath }, tier: bestTier });
  }

  return tiered.sort((a, b) => b.tier - a.tier || compareForRelevance(a.match, b.match)).map((t) => t.match);
}
