// src/steward/packet.ts — bounded steward input packet: fenced issue + frozen plan + capped lane diff (#2095, #2096, ADR-0144)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripHiddenContent } from '../filing/sanitize.js';
import { wrapUntrustedIssueBody } from '../utils/untrusted-input.js';

/**
 * Per-item caps. Title/body come from ADR-0144's Packet table; plan is provisional (#2095).
 * The diff caps are bytes/lines and provisional (#2096); ADR-0144 lists 20000 chars of diff.
 */
export const STEWARD_PACKET_CAPS = { title: 256, body: 8000, plan: 8000, diffBytes: 20000, diffLines: 2000 } as const;

/** Lane diff artifact name inside the run directory (same name the benchmark artifact writer uses). */
const DIFF_ARTIFACT = 'diff.patch';

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

export interface StewardPacket {
  issue: StewardIssueItem;
  plan: StewardPlanItem | StewardAbsentItem;
  diff: StewardDiffItem | StewardAbsentItem;
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

/** Assembles the bounded steward packet: the fenced issue, the frozen plan and the capped lane diff. Reads the plan and lane diff; writes nothing. */
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
  return { issue: issueItem, plan, diff };
}
