// src/filing/sanitize.ts — Strip hidden content and fence evidence safely when filing bugs (#1841).

import type { EvidencePack } from '../types/index.js';

// Unicode format chars (zero-width, bidi, tag, soft hyphen) plus C0/C1 controls except \t \n \r.
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\p{Cf}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;

/** Remove HTML comments with linear scans; an unterminated `<!--` hides to end of text. */
function removeComments(text: string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('<!--', i);
    if (open === -1) return out + text.slice(i);
    out += text.slice(i, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return out;
    i = close + 3;
  }
}

/** Remove invisible characters and HTML comments (incl. an unterminated `<!--`) until stable. */
export function stripHiddenContent(text: string): string {
  let out = text;
  let prev: string;
  do {
    prev = out;
    out = removeComments(out.replace(INVISIBLE_RE, ''));
  } while (out !== prev);
  return out;
}

/** Strip hidden content from every string field of an EvidencePack (non-mutating). */
export function sanitizeEvidence(evidence: EvidencePack): EvidencePack {
  const out: EvidencePack = {
    ...evidence,
    repo: stripHiddenContent(evidence.repo),
    issue: stripHiddenContent(evidence.issue),
    model: stripHiddenContent(evidence.model),
    component: stripHiddenContent(evidence.component),
    eventExcerpt: stripHiddenContent(evidence.eventExcerpt),
    logPath: stripHiddenContent(evidence.logPath),
  };
  if (evidence.relatedIssue) {
    out.relatedIssue = { ...evidence.relatedIssue, repo: stripHiddenContent(evidence.relatedIssue.repo) };
  }
  return out;
}

/** Wrap text in a backtick fence of max(5, longest inner run + 1) so it cannot close the fence. */
export function fenceExcerpt(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(Math.max(5, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
