// src/blockers/claim.ts — deterministic parser for the `BLOCKED_BY:` claim a PLAN or BUILD
// model prints when the work cannot proceed until a separate prerequisite lands (#2317).
//
// Pure: no I/O. Anything malformed is rejected (never repaired) so the caller falls back to
// the `escalate` park. Hidden content is rejected, not stripped (ADR-0130), and a claim that
// appears only inside an `<untrusted-issue-body>` region is never parsed (ADR-0129).

import { stripHiddenContent } from '../filing/sanitize.js';
import { findDuplicateStory } from '../readiness/duplicate-guard.js';
import { type BlockerClaim, BlockerClaimSchema } from './file-blocker.js';

export const MAX_BLOCKER_TITLE_LENGTH = 120;

export type BlockerClaimParse =
  { ok: true; claim: BlockerClaim; line: string } | { ok: false; reason: string; line: string };

/** Shared prompt paragraph; both phase prompts embed it verbatim. */
export const BLOCKED_BY_PROMPT_RULE = `If the work cannot be done until some separate prerequisite lands, print instead of ESCALATE:
BLOCKED_BY: <short issue title> | <one-line problem statement>
\`\`\`
In scope:
- <item>
Acceptance criteria:
- <item>
\`\`\`
then stop. Name only the missing prerequisite, never this issue's own scope. Use ESCALATE: for questions.`;

const UNTRUSTED_REGION_RE = /<untrusted-issue-body>[\s\S]*?<\/untrusted-issue-body>/g;
const UNTRUSTED_OPEN = '<untrusted-issue-body>';
const FENCE_RE = /^(`{3,})\s*$/;
const SECTION_RE = /^\s*(?:#+\s*)?(in scope|acceptance criteria)\s*:?\s*$/i;
const BULLET_RE = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/;

function stripUntrusted(output: string): string {
  const closed = output.replace(UNTRUSTED_REGION_RE, '');
  const open = closed.indexOf(UNTRUSTED_OPEN);
  return open === -1 ? closed : closed.slice(0, open);
}

export function parseBlockerClaim(output: string): BlockerClaimParse | null {
  const lines = stripUntrusted(output).split('\n');
  const index = lines.findIndex((l) => l.startsWith('BLOCKED_BY:'));
  if (index === -1) return null;
  const line = lines[index]!;
  const reject = (reason: string): BlockerClaimParse => ({ ok: false, reason, line });

  const rest = line.slice('BLOCKED_BY:'.length);
  const bar = rest.indexOf('|');
  const title = bar === -1 ? '' : rest.slice(0, bar).trim();
  const problem = bar === -1 ? '' : rest.slice(bar + 1).trim();
  if (!title || !problem) return reject('missing title or problem');

  let cursor = index + 1;
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++;
  const open = FENCE_RE.exec(lines[cursor] ?? '');
  if (!open) return reject('missing fenced block');
  const fence = open[1]!;
  const close = lines.findIndex((l, i) => i > cursor && l.trim() === fence);
  if (close === -1) return reject('unterminated fenced block');

  const sections: Record<'inScope' | 'acceptance', string[]> = { inScope: [], acceptance: [] };
  let current: 'inScope' | 'acceptance' | null = null;
  for (const body of lines.slice(cursor + 1, close)) {
    if (body.trim() === '') continue;
    const heading = SECTION_RE.exec(body);
    if (heading) {
      current = heading[1]!.toLowerCase() === 'in scope' ? 'inScope' : 'acceptance';
      continue;
    }
    const bullet = BULLET_RE.exec(body);
    if (!bullet || !current) return reject('unexpected line in claim block');
    sections[current].push(bullet[1]!.trim());
  }

  const parsed = BlockerClaimSchema.safeParse({ title, problem, ...sections });
  if (!parsed.success) return reject(parsed.error.issues.map((i) => i.message).join('; '));
  if (title.length > MAX_BLOCKER_TITLE_LENGTH) {
    return reject(`title longer than ${MAX_BLOCKER_TITLE_LENGTH} characters`);
  }
  const fields = [parsed.data.title, parsed.data.problem, ...parsed.data.inScope, ...parsed.data.acceptance];
  if (fields.some((v) => stripHiddenContent(v) !== v)) return reject('claim contains hidden content');
  return { ok: true, claim: parsed.data, line };
}

const normalizeTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

/** A reason when the claim restates the parent's own scope (it must name a prerequisite), else null. */
export function claimRestatesParent(
  claim: BlockerClaim,
  parent: { number: number; title: string; body: string },
): string | null {
  if (normalizeTitle(claim.title) === normalizeTitle(parent.title)) {
    return `claim title equals #${parent.number}'s title`;
  }
  const match = findDuplicateStory(`${claim.title} ${claim.problem} ${claim.inScope.join(' ')}`, [
    { number: parent.number, title: parent.title, body: parent.body },
  ]);
  return match ? `claim restates #${parent.number}'s own scope (similarity ${match.similarity.toFixed(2)})` : null;
}
