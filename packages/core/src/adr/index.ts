// src/adr/index.ts — reads the checkout's ADRs through a RepoContextReader and renders
// the Accepted ones as binding design constraints for the PLAN prompt (#481).
import { formatAdrNumber, normalizeStatus, tryParseAdr } from '@on-par/adr-kit';
import type { RepoContextReader } from '@on-par/repo-context';

export const DEFAULT_ADR_DIR = 'docs/adr';
/** Cap on injected ADRs — bounds boss-model context on ADR-heavy repos. */
export const DEFAULT_MAX_ADRS = 20;
/** Cap on the Decision text quoted per ADR. */
export const DEFAULT_MAX_DECISION_CHARS = 600;

const NON_ADR_FILENAME = /^(readme|index|_?template)\.md$/i;

export interface ActiveAdr {
  /** undefined when neither the H1 nor the filename carries a number. */
  number: number | undefined;
  title: string;
  /** Raw status text as written, e.g. 'Accepted'. */
  status: string;
  date: string;
  /** Repo-root-relative path, e.g. 'docs/adr/0004-narrow-public-core-api.md'. */
  path: string;
  decision: string;
}

export type AdrSkipReason = 'unparsable' | 'inactive';

export interface AdrContext {
  dir: string;
  /** Accepted ADRs, ascending by number (unnumbered last), then by path. */
  active: ActiveAdr[];
  skipped: { path: string; reason: AdrSkipReason }[];
  /** Candidate ADR files seen in `dir`. */
  scanned: number;
  /** Accepted ADRs dropped by the maxAdrs cap — never silently zero. */
  truncated: number;
}

/** Shared with `adr/write.ts` so the two ADR directory scans never drift apart. */
export function isNonAdrFile(name: string): boolean {
  return NON_ADR_FILENAME.test(name);
}

export async function readAdrContext(
  reader: RepoContextReader,
  opts?: { dir?: string; maxAdrs?: number },
): Promise<AdrContext> {
  const dir = opts?.dir ?? DEFAULT_ADR_DIR;
  const maxAdrs = opts?.maxAdrs ?? DEFAULT_MAX_ADRS;

  const entries = await reader.readDir(dir);
  const candidates = entries.filter(
    (entry) => entry.type === 'file' && /\.md$/i.test(entry.name) && !isNonAdrFile(entry.name),
  );

  const active: ActiveAdr[] = [];
  const skipped: { path: string; reason: AdrSkipReason }[] = [];

  for (const entry of candidates) {
    const file = await reader.readFile(entry.path);
    if (file === undefined) {
      skipped.push({ path: entry.path, reason: 'unparsable' });
      continue;
    }

    const result = tryParseAdr(file.text, { filename: entry.name });
    if (!result.ok) {
      skipped.push({ path: entry.path, reason: 'unparsable' });
      continue;
    }

    if (normalizeStatus(result.adr.status) !== 'Accepted') {
      skipped.push({ path: entry.path, reason: 'inactive' });
      continue;
    }

    active.push({
      number: result.adr.number,
      title: result.adr.title,
      status: result.adr.status,
      date: result.adr.date,
      path: entry.path,
      decision: result.adr.decision,
    });
  }

  active.sort((a, b) => {
    if (a.number === undefined && b.number === undefined) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (a.number === undefined) return 1;
    if (b.number === undefined) return -1;
    if (a.number !== b.number) return a.number - b.number;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const truncated = Math.max(0, active.length - maxAdrs);
  const kept = active.slice(0, maxAdrs);

  return { dir, active: kept, skipped, scanned: candidates.length, truncated };
}

/** 'ADR-0004' when the ADR carries a number, else its path — used by the renderer and PLAN's log line. */
export function adrLabel(adr: ActiveAdr): string {
  return adr.number === undefined ? adr.path : `ADR-${formatAdrNumber(adr.number)}`;
}

function condense(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export function renderAdrConstraints(ctx: AdrContext, opts?: { maxDecisionChars?: number }): string {
  if (ctx.active.length === 0) {
    return '';
  }
  const maxDecisionChars = opts?.maxDecisionChars ?? DEFAULT_MAX_DECISION_CHARS;

  const lines: string[] = [
    `## Active architecture decisions (${ctx.dir})`,
    '',
    'These ADRs are Accepted in this checkout. They are binding constraints on your design,',
    'not suggestions.',
    '',
  ];

  for (const adr of ctx.active) {
    lines.push(
      `- ${adrLabel(adr)} — ${adr.title} (Accepted, ${adr.date}) — ${adr.path}`,
      `  Decision: ${condense(adr.decision, maxDecisionChars)}`,
    );
  }

  if (ctx.truncated > 0) {
    lines.push('', `(${ctx.truncated} more Accepted ADR(s) omitted by the injection cap.)`);
  }

  lines.push(
    '',
    'Design within these decisions; open the file above if you need the full text. If the issue',
    'can only be satisfied by contradicting one of them, do NOT silently diverge: name the ADR',
    'and the conflict in `openQuestions` and in the spec body.',
    '',
  );

  return lines.join('\n');
}
