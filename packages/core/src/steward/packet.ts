// src/steward/packet.ts — bounded steward input packet: fenced issue + frozen plan + capped lane diff + failing checker logs (#2095, #2096, #2097, #2098, ADR-0144)
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { rankAdrsByRelevance } from '../adr/relevance.js';
import type { AdrMatchReason, AdrRelevanceCandidate } from '../adr/relevance.js';
import { capEvidenceExcerpt } from '../filing/index.js';
import { stripHiddenContent } from '../filing/sanitize.js';
import { wrapUntrustedIssueBody } from '../utils/untrusted-input.js';

/**
 * Per-item caps. Title/body come from ADR-0144's Packet table; plan is provisional (#2095).
 * The diff caps are bytes/lines and provisional (#2096); ADR-0144 lists 20000 chars of diff.
 * The log caps come from ADR-0144's Failing checkers row: 10 checkers, 2000 chars each (#2097).
 * The ADR caps are provisional (#2098): ADR-0144's Packet table has no ADR row. 600 matches DEFAULT_MAX_DECISION_CHARS in adr/index.ts.
 */
export const STEWARD_PACKET_CAPS = {
  title: 256,
  body: 8000,
  plan: 8000,
  diffBytes: 20000,
  diffLines: 2000,
  logChars: 2000,
  logFiles: 10,
  adrs: 5,
  adrDecisionChars: 600,
} as const;

/** Lane diff artifact name inside the run directory (same name the benchmark artifact writer uses). */
const DIFF_ARTIFACT = 'diff.patch';

/** Persisted packet file name inside the run directory. */
export const STEWARD_PACKET_FILE = 'steward-packet.json';

export interface StewardIssueInput {
  number: number;
  title: string;
  body: string;
}

/** Size metadata for one capped text field. Sizes are string lengths after hidden-content stripping. */
export interface StewardTextMeta {
  originalChars: number;
  chars: number;
  truncated: boolean;
}

export interface StewardIssueItem {
  status: 'present';
  number: number;
  /** wrapUntrustedIssueBody(`${title}\n\n${body}`) over the capped, sanitized title and body. */
  untrustedBlock: string;
  title: StewardTextMeta;
  body: StewardTextMeta;
}

export interface StewardPlanItem extends StewardTextMeta {
  status: 'present';
  path: string;
  text: string;
}

export interface StewardAbsentItem {
  status: 'absent';
  reason: 'missing' | 'unreadable' | 'empty';
}

/** The lane diff, capped by UTF-8 bytes and lines. Sizes are measured after hidden-content stripping. */
export interface StewardDiffItem {
  status: 'present';
  path: string;
  /** Capped diff text; ends with the truncation marker when `truncated`. */
  text: string;
  originalBytes: number;
  /** UTF-8 bytes of kept diff content, excluding the marker. */
  bytes: number;
  originalLines: number;
  /** Lines of kept diff content, excluding the marker. */
  lines: number;
  truncated: boolean;
}

/** One failing checker log: a sanitized, capped excerpt plus a host:path pointer to the raw log (ADR-0131). */
export interface StewardLogEntry extends StewardTextMeta {
  /** Log file name without the `.log` extension, e.g. `verify-verify`. */
  name: string;
  /** Absolute path of the raw log on the originating machine. */
  path: string;
  /** `${host}:${path}`; the raw log itself is never in the packet. */
  pointer: string;
  /** Excerpt after stripHiddenContent and capEvidenceExcerpt. */
  text: string;
}

export interface StewardLogsItem {
  status: 'present';
  /** Directory the logs were read from. */
  dir: string;
  entries: StewardLogEntry[];
  /** Number of non-empty log files found before the file cap. */
  originalCount: number;
  /** True when originalCount exceeded the file cap. */
  truncated: boolean;
}

/** One ranked ADR. Decision is sanitized and capped; meta describes the decision text. */
export interface StewardAdrEntry extends StewardTextMeta {
  /** Omitted when the ADR has no number. */
  number?: number;
  title: string;
  path: string;
  reason: AdrMatchReason;
  /** The changed path that produced the match. */
  changedPath: string;
  decision: string;
}

export interface StewardAdrsItem {
  status: 'present';
  entries: StewardAdrEntry[];
  /** Number of ADRs the ranker matched before the cap. */
  originalCount: number;
  /** True when originalCount exceeded the cap. */
  truncated: boolean;
}

export interface StewardPacket {
  issue: StewardIssueItem;
  plan: StewardPlanItem | StewardAbsentItem;
  diff: StewardDiffItem | StewardAbsentItem;
  logs: StewardLogsItem | StewardAbsentItem;
  adrs: StewardAdrsItem | StewardAbsentItem;
}

export interface BuildStewardPacketOptions {
  /** Explicit frozen-spec path. Default: join(runDir, `issue-${issue.number}.md`). */
  planPath?: string;
  maxTitleChars?: number;
  maxBodyChars?: number;
  maxPlanChars?: number;
  /** Explicit lane diff path. Default: join(runDir, 'diff.patch'). */
  diffPath?: string;
  maxDiffBytes?: number;
  maxDiffLines?: number;
  /** Explicit failing-checker log directory. Default: the highest-numbered `check-r<N>` directory in runDir. */
  checkLogDir?: string;
  maxLogChars?: number;
  maxLogFiles?: number;
  /** Host printed in each raw-log pointer (default: os.hostname()). */
  host?: string;
  /** Accepted ADRs with their raw markdown, ranked by rankAdrsByRelevance (#1722). Omitted → adrs absent 'missing'. */
  adrCandidates?: readonly AdrRelevanceCandidate[];
  /** Changed paths to rank against. Default: the paths in the uncapped lane diff. */
  changedPaths?: readonly string[];
  maxAdrs?: number;
  maxAdrDecisionChars?: number;
}

function capText(raw: string, max: number): { text: string } & StewardTextMeta {
  const clean = stripHiddenContent(raw);
  const truncated = clean.length > max;
  const text = truncated ? clean.slice(0, max) : clean;
  return { text, originalChars: clean.length, chars: text.length, truncated };
}

async function readArtifact(path: string): Promise<{ raw: string } | StewardAbsentItem> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: 'absent', reason: missing ? 'missing' : 'unreadable' };
  }
  if (raw.trim() === '') return { status: 'absent', reason: 'empty' };
  return { raw };
}

/** A trailing newline does not start a new line. */
function countLines(s: string): number {
  if (s === '') return 0;
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}

function diffTruncationMarker(bytes: number, originalBytes: number, lines: number, originalLines: number): string {
  return `\n[diff truncated: kept ${bytes} of ${originalBytes} bytes, ${lines} of ${originalLines} lines]\n`;
}

function capDiff(raw: string, maxBytes: number, maxLines: number): Omit<StewardDiffItem, 'status' | 'path'> {
  const clean = stripHiddenContent(raw);
  const originalBytes = Buffer.byteLength(clean, 'utf8');
  const originalLines = countLines(clean);
  if (originalBytes <= maxBytes && originalLines <= maxLines) {
    return { text: clean, originalBytes, bytes: originalBytes, originalLines, lines: originalLines, truncated: false };
  }

  let kept = clean;
  if (originalLines > maxLines) {
    // Keep the first maxLines lines, each with its trailing newline.
    let end = 0;
    for (let n = 0; n < maxLines; n++) end = clean.indexOf('\n', end) + 1;
    kept = clean.slice(0, end);
  }
  const buf = Buffer.from(kept, 'utf8');
  if (buf.length > maxBytes) {
    let end = maxBytes;
    // Back off continuation bytes so a multi-byte character is never split.
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    kept = buf.subarray(0, end).toString('utf8');
  }
  const bytes = Buffer.byteLength(kept, 'utf8');
  const lines = countLines(kept);
  const marker = diffTruncationMarker(bytes, originalBytes, lines, originalLines);
  const text = kept === '' || kept.endsWith('\n') ? kept + marker.slice(1) : kept + marker;
  return { text, originalBytes, bytes, originalLines, lines, truncated: true };
}

/** Repo-relative paths named by a unified diff's `---`/`+++` headers, deduped in first-seen order. */
export function diffChangedPaths(diff: string): string[] {
  const seen = new Set<string>();
  const patterns = [/^\+\+\+ b\/(.+)$/, /^--- a\/(.+)$/, /^\+\+\+ "b\/(.+)"$/, /^--- "a\/(.+)"$/];
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.replace(/\r$/, '').replace(/\t.*$/, '');
    for (const re of patterns) {
      const m = re.exec(line);
      if (m) {
        seen.add(m[1]);
        break;
      }
    }
  }
  return [...seen];
}

function selectAdrs(
  candidates: readonly AdrRelevanceCandidate[] | undefined,
  changedPaths: readonly string[],
  maxAdrs: number,
  maxDecisionChars: number,
): StewardAdrsItem | StewardAbsentItem {
  if (candidates === undefined) return { status: 'absent', reason: 'missing' };
  const ranked = rankAdrsByRelevance(candidates, changedPaths);
  if (ranked.length === 0) return { status: 'absent', reason: 'empty' };
  const entries = ranked.slice(0, maxAdrs).map((m): StewardAdrEntry => {
    const { text, ...meta } = capText(m.adr.decision, maxDecisionChars);
    return {
      ...(m.adr.number === undefined ? {} : { number: m.adr.number }),
      title: stripHiddenContent(m.adr.title),
      path: stripHiddenContent(m.adr.path),
      reason: m.reason,
      changedPath: stripHiddenContent(m.changedPath),
      decision: text,
      ...meta,
    };
  });
  return { status: 'present', entries, originalCount: ranked.length, truncated: ranked.length > maxAdrs };
}

/** Writes the packet as `steward-packet.json` in runDir (atomic: temp file then rename). Returns the file path. */
export async function writeStewardPacket(runDir: string, packet: StewardPacket): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const file = join(runDir, STEWARD_PACKET_FILE);
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(packet, null, 2)}\n`, 'utf-8');
  await rename(tmp, file);
  return file;
}

/** The `check-r<N>` directory of the last CHECK round (numeric max), or absent. */
async function latestRoundDir(runDir: string): Promise<string | StewardAbsentItem> {
  let entries;
  try {
    entries = await readdir(runDir, { withFileTypes: true });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: 'absent', reason: missing ? 'missing' : 'unreadable' };
  }
  let best: { name: string; round: number } | undefined;
  for (const e of entries) {
    const m = /^check-r(\d+)$/.exec(e.name);
    if (!m || !e.isDirectory()) continue;
    const round = Number(m[1]);
    if (!best || round > best.round) best = { name: e.name, round };
  }
  return best ? join(runDir, best.name) : { status: 'absent', reason: 'missing' };
}

async function readCheckerLogs(
  dir: string,
  maxChars: number,
  maxFiles: number,
  host: string,
): Promise<StewardLogsItem | StewardAbsentItem> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { status: 'absent', reason: missing ? 'missing' : 'unreadable' };
  }
  const files = dirents
    .filter((e) => e.isFile() && e.name.endsWith('.log'))
    .map((e) => e.name)
    .sort();
  if (files.length === 0) return { status: 'absent', reason: 'missing' };
  const entries: StewardLogEntry[] = [];
  for (const file of files) {
    const path = join(dir, file);
    const read = await readArtifact(path);
    if ('status' in read) continue;
    const c = capEvidenceExcerpt(stripHiddenContent(read.raw), maxChars);
    entries.push({
      name: file.slice(0, -'.log'.length),
      path,
      pointer: `${host}:${path}`,
      text: c.text,
      originalChars: c.totalChars,
      chars: c.shownChars,
      truncated: c.truncated,
    });
  }
  if (entries.length === 0) return { status: 'absent', reason: 'empty' };
  return {
    status: 'present',
    dir,
    entries: entries.slice(0, maxFiles),
    originalCount: entries.length,
    truncated: entries.length > maxFiles,
  };
}

/** Assembles the bounded steward packet: the fenced issue, the frozen plan, the capped lane diff, the sanitized failing checker logs and the ranked ADRs. Reads the plan, diff and logs, ranks the supplied ADRs, and writes only `steward-packet.json` in runDir. No model call, no GitHub or network I/O. */
export async function buildStewardPacket(
  runDir: string,
  issue: StewardIssueInput,
  opts: BuildStewardPacketOptions = {},
): Promise<StewardPacket> {
  const { text: titleText, ...title } = capText(issue.title, opts.maxTitleChars ?? STEWARD_PACKET_CAPS.title);
  const { text: bodyText, ...body } = capText(issue.body, opts.maxBodyChars ?? STEWARD_PACKET_CAPS.body);
  // Cap before wrapping so the block delimiters are never cut.
  const untrustedBlock = wrapUntrustedIssueBody(`${titleText}\n\n${bodyText}`);
  const issueItem: StewardIssueItem = { status: 'present', number: issue.number, untrustedBlock, title, body };

  const planPath = opts.planPath ?? join(runDir, `issue-${issue.number}.md`);
  const planRead = await readArtifact(planPath);
  const plan: StewardPlanItem | StewardAbsentItem =
    'raw' in planRead
      ? { status: 'present', path: planPath, ...capText(planRead.raw, opts.maxPlanChars ?? STEWARD_PACKET_CAPS.plan) }
      : planRead;

  const diffPath = opts.diffPath ?? join(runDir, DIFF_ARTIFACT);
  const diffRead = await readArtifact(diffPath);
  const cleanDiff = 'raw' in diffRead ? stripHiddenContent(diffRead.raw) : '';
  const diff: StewardDiffItem | StewardAbsentItem =
    'raw' in diffRead
      ? {
          status: 'present',
          path: diffPath,
          ...capDiff(
            diffRead.raw,
            opts.maxDiffBytes ?? STEWARD_PACKET_CAPS.diffBytes,
            opts.maxDiffLines ?? STEWARD_PACKET_CAPS.diffLines,
          ),
        }
      : diffRead;

  const host = stripHiddenContent(opts.host ?? hostname()) || 'unknown-host';
  const logDir = opts.checkLogDir ?? (await latestRoundDir(runDir));
  const logs =
    typeof logDir === 'string'
      ? await readCheckerLogs(
          logDir,
          opts.maxLogChars ?? STEWARD_PACKET_CAPS.logChars,
          opts.maxLogFiles ?? STEWARD_PACKET_CAPS.logFiles,
          host,
        )
      : logDir;

  const changedPaths = opts.changedPaths ?? diffChangedPaths(cleanDiff);
  const adrs = selectAdrs(
    opts.adrCandidates,
    changedPaths,
    opts.maxAdrs ?? STEWARD_PACKET_CAPS.adrs,
    opts.maxAdrDecisionChars ?? STEWARD_PACKET_CAPS.adrDecisionChars,
  );

  const packet: StewardPacket = { issue: issueItem, plan, diff, logs, adrs };
  await writeStewardPacket(runDir, packet);
  return packet;
}
