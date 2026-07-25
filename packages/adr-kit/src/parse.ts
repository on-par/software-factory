// src/parse.ts — parseAdr, tryParseAdr, and the convention-detection helpers (#467).
import type { Adr, AdrReference } from './adr.js';
import { AdrKitError } from './adr.js';
import type { AdrConvention } from './convention.js';
import { NYGARD_CONVENTION } from './convention.js';
import { adrNumberFromFilename } from './numbering.js';

type KnownField = 'status' | 'date' | 'context' | 'decision' | 'consequences' | 'references';

function matchKnownField(heading: string): KnownField | undefined {
  const trimmed = heading.trim();
  if (/^status$/i.test(trimmed)) return 'status';
  if (/^date$/i.test(trimmed)) return 'date';
  if (/^context/i.test(trimmed)) return 'context';
  if (/^decision/i.test(trimmed)) return 'decision';
  if (/^consequences$/i.test(trimmed)) return 'consequences';
  if (/^(references|links)$/i.test(trimmed)) return 'references';
  return undefined;
}

function trimBlankEdges(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start++;
  while (end > start && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

interface ParsedSection {
  heading: string;
  headingMarker: string;
  body: string;
}

function parseReferenceLine(line: string): AdrReference | undefined {
  let m = /^\s*([-*])\s+\[([^\]]+)]\(([^)]+)\)\s*$/.exec(line);
  if (m) return { text: m[2], url: m[3], marker: m[1] };
  m = /^\s*([-*])\s+(<?https?:\/\/[^\s>]+>?)\s*$/.exec(line);
  if (m) return { text: m[2], url: m[2], marker: m[1] };
  m = /^\s*([-*])\s+(.+)$/.exec(line);
  if (m) return { text: m[2], marker: m[1] };
  return undefined;
}

interface ParseInternalResult {
  adr: Adr;
  convention: AdrConvention;
}

function parseInternal(source: string, options?: { filename?: string }): ParseInternalResult {
  const eol: '\n' | '\r\n' = source.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = source.endsWith('\n');
  const lines = source.split(/\r?\n/);

  let idx = 0;
  let frontmatter: Record<string, string> | undefined;
  if (lines[0] === '---') {
    frontmatter = {};
    idx = 1;
    while (idx < lines.length && lines[idx] !== '---') {
      const line = lines[idx];
      const colon = line.indexOf(':');
      if (colon !== -1 && line.trim() !== '') {
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        frontmatter[key] = value;
      }
      idx++;
    }
    idx++; // skip the closing '---'
  }

  while (idx < lines.length && !/^#\s+/.test(lines[idx])) idx++;
  if (idx >= lines.length) throw new AdrKitError('adr has no H1 title', 'parse');
  const h1 = lines[idx];
  idx++;

  let number: number | undefined;
  let title = '';
  let titleStyle: AdrConvention['titleStyle'] = 'plain';
  let numberWidth = NYGARD_CONVENTION.numberWidth;

  let m = /^#\s+ADR[-\s]?(\d+)\s*[:.—-]\s*(.+)$/i.exec(h1);
  if (m) {
    number = Number(m[1]);
    title = m[2];
    titleStyle = 'adr-prefix';
    numberWidth = m[1].length;
  } else if ((m = /^#\s+(\d+)\.\s*(.+)$/.exec(h1))) {
    number = Number(m[1]);
    title = m[2];
    titleStyle = 'numbered-dot';
  } else {
    m = /^#\s+(.+)$/.exec(h1);
    title = m ? m[1] : '';
    titleStyle = 'plain';
  }
  if (number === undefined) {
    number = adrNumberFromFilename(options?.filename ?? '');
  }

  const preambleLines: string[] = [];
  while (idx < lines.length && !/^##\s+/.test(lines[idx])) {
    preambleLines.push(lines[idx]);
    idx++;
  }

  let status = frontmatter?.status ?? '';
  let date = frontmatter?.date ?? '';
  let metaBullet = '- ';
  let sawPreambleStatus = false;
  for (const line of preambleLines) {
    const pm = /^(-\s+|\*\s+)?(Status|Date)\s*:\s*(.*)$/i.exec(line);
    if (!pm) continue;
    const bullet = pm[1] ?? '';
    const label = pm[2].toLowerCase();
    const value = pm[3].trim();
    if (label === 'status' && !frontmatter) {
      status = value;
      metaBullet = bullet;
      sawPreambleStatus = true;
    } else if (label === 'date' && !frontmatter) {
      date = value;
      metaBullet = bullet;
    }
  }

  const sections: ParsedSection[] = [];
  let current: { heading: string; headingMarker: string; bodyLines: string[] } | undefined;
  for (const line of lines.slice(idx)) {
    const hm = /^(#{2,6})\s+(.+)$/.exec(line);
    if (hm) {
      if (current)
        sections.push({
          heading: current.heading,
          headingMarker: current.headingMarker,
          body: trimBlankEdges(current.bodyLines),
        });
      current = { heading: hm[2], headingMarker: `${hm[1]} `, bodyLines: [] };
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  if (current)
    sections.push({
      heading: current.heading,
      headingMarker: current.headingMarker,
      body: trimBlankEdges(current.bodyLines),
    });

  let context = '';
  let decision = '';
  let consequences = '';
  let references: AdrReference[] = [];
  const sectionOrder: string[] = [];
  const extraSections: { heading: string; body: string }[] = [];
  let headingPrefix = NYGARD_CONVENTION.headingPrefix;
  let metaStyle: AdrConvention['metaStyle'] = frontmatter ? 'frontmatter' : 'bullet-list';
  const labels: Partial<Record<KnownField, string>> = {};

  for (const section of sections) {
    sectionOrder.push(section.heading);
    headingPrefix = section.headingMarker;
    const field = matchKnownField(section.heading);
    if (field === 'status') {
      labels.status = section.heading;
      if (!status) status = section.body;
      if (!sawPreambleStatus && !frontmatter) metaStyle = 'sections';
      continue;
    }
    if (field === 'date') {
      labels.date = section.heading;
      if (!date) date = section.body;
      continue;
    }
    if (field === 'context') {
      labels.context = section.heading;
      context = section.body;
      continue;
    }
    if (field === 'decision') {
      labels.decision = section.heading;
      decision = section.body;
      continue;
    }
    if (field === 'consequences') {
      labels.consequences = section.heading;
      consequences = section.body;
      continue;
    }
    if (field === 'references') {
      const bodyLines = section.body === '' ? [] : section.body.split('\n');
      const nonBlank = bodyLines.filter((line) => line.trim() !== '');
      const parsedRefs = nonBlank.map(parseReferenceLine);
      if (nonBlank.length > 0 && parsedRefs.every((ref): ref is AdrReference => ref !== undefined)) {
        labels.references = section.heading;
        references = parsedRefs;
      } else {
        extraSections.push({ heading: section.heading, body: section.body });
      }
      continue;
    }
    extraSections.push({ heading: section.heading, body: section.body });
  }

  const adr: Adr = {
    number,
    title,
    status,
    date,
    context,
    decision,
    consequences,
    references,
    sectionOrder,
    extraSections,
  };

  const convention: AdrConvention = {
    ...NYGARD_CONVENTION,
    titleStyle,
    numberWidth,
    metaStyle,
    metaBullet: frontmatter ? NYGARD_CONVENTION.metaBullet : metaBullet,
    statusLabel: labels.status ?? NYGARD_CONVENTION.statusLabel,
    dateLabel: labels.date ?? NYGARD_CONVENTION.dateLabel,
    contextLabel: labels.context ?? NYGARD_CONVENTION.contextLabel,
    decisionLabel: labels.decision ?? NYGARD_CONVENTION.decisionLabel,
    consequencesLabel: labels.consequences ?? NYGARD_CONVENTION.consequencesLabel,
    referencesLabel: labels.references ?? NYGARD_CONVENTION.referencesLabel,
    headingPrefix,
    eol,
    trailingNewline,
  };

  return { adr, convention };
}

export function parseAdr(source: string, options?: { filename?: string }): Adr {
  return parseInternal(source, options).adr;
}

export type ParseAdrResult = { ok: true; adr: Adr; convention: AdrConvention } | { ok: false; errors: string[] };

export function tryParseAdr(source: string, options?: { filename?: string }): ParseAdrResult {
  try {
    const { adr, convention } = parseInternal(source, options);
    return { ok: true, adr, convention };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function inferConvention(source: string): AdrConvention {
  return parseInternal(source).convention;
}

export function detectConvention(docs: readonly string[]): AdrConvention {
  if (docs.length === 0) return NYGARD_CONVENTION;

  const inferred: AdrConvention[] = [];
  for (const doc of docs) {
    try {
      inferred.push(inferConvention(doc));
    } catch {
      // Skip documents that fail to parse; they contribute no vote.
    }
  }
  if (inferred.length === 0) return NYGARD_CONVENTION;

  const result = { ...inferred[0] };
  const keys = Object.keys(NYGARD_CONVENTION) as (keyof AdrConvention)[];
  for (const key of keys) {
    const counts = new Map<AdrConvention[typeof key], number>();
    for (const conv of inferred) {
      const value = conv[key];
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    let bestValue = inferred[0][key];
    let bestCount = -1;
    for (const conv of inferred) {
      const value = conv[key];
      const count = counts.get(value) ?? 0;
      if (count > bestCount) {
        bestCount = count;
        bestValue = value;
      }
    }
    (result as Record<keyof AdrConvention, unknown>)[key] = bestValue;
  }
  return result;
}
