// src/steward/packet.ts — bounded steward input packet: fenced issue + frozen plan (#2095, ADR-0144)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripHiddenContent } from '../filing/sanitize.js';
import { wrapUntrustedIssueBody } from '../utils/untrusted-input.js';

/** Per-item char caps. Title/body come from ADR-0144's Packet table; plan is provisional (#2095). */
export const STEWARD_PACKET_CAPS = { title: 256, body: 8000, plan: 8000 } as const;

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

export interface StewardPacket {
  issue: StewardIssueItem;
  plan: StewardPlanItem | StewardAbsentItem;
}

export interface BuildStewardPacketOptions {
  /** Explicit frozen-spec path. Default: join(runDir, `issue-${issue.number}.md`). */
  planPath?: string;
  maxTitleChars?: number;
  maxBodyChars?: number;
  maxPlanChars?: number;
}

function capText(raw: string, max: number): { text: string } & StewardTextMeta {
  const clean = stripHiddenContent(raw);
  const truncated = clean.length > max;
  const text = truncated ? clean.slice(0, max) : clean;
  return { text, originalChars: clean.length, chars: text.length, truncated };
}

/** Assembles the bounded steward packet: the fenced issue and the frozen plan. Reads one file; writes nothing. */
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
  let raw: string;
  try {
    raw = await readFile(planPath, 'utf-8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { issue: issueItem, plan: { status: 'absent', reason: missing ? 'missing' : 'unreadable' } };
  }
  if (raw.trim() === '') return { issue: issueItem, plan: { status: 'absent', reason: 'empty' } };
  const plan: StewardPlanItem = {
    status: 'present',
    path: planPath,
    ...capText(raw, opts.maxPlanChars ?? STEWARD_PACKET_CAPS.plan),
  };
  return { issue: issueItem, plan };
}
