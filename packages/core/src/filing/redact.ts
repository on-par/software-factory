// src/filing/redact.ts — Replace target-repo identifiers with placeholders for upstream reports (#1858).

import { factoryBranchPrefixes } from '../utils/index.js';
import { stripHiddenContent } from './sanitize.js';

export type RedactionClass = 'repo' | 'branch' | 'path' | 'user' | 'host' | 'email' | 'url' | 'secret';

export const REDACTION_PLACEHOLDERS: Readonly<Record<RedactionClass, string>> = {
  repo: '<repo>',
  branch: '<branch>',
  path: '<path>',
  user: '<user>',
  host: '<host>',
  email: '<email>',
  url: '<url>',
  secret: '<secret>',
};

export interface RedactionContext {
  /** Known `owner/name` slugs of the target repo(s). The bare name (>= 4 chars) and owner are redacted too. */
  repoSlugs?: readonly string[];
  /** Known branch names. */
  branches?: readonly string[];
  /** Branch prefix; factory branches `<prefix>/<n>-…` on factoryBranchPrefixes(prefix) are redacted. */
  branchPrefix?: string;
  usernames?: readonly string[];
  hostnames?: readonly string[];
}

const P = REDACTION_PLACEHOLDERS;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

function nonBlank(list: readonly string[] | undefined): string[] {
  return (list ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Longest first so a slug is replaced before its parts. */
function byLengthDesc(list: string[]): string[] {
  return [...new Set(list)].sort((a, b) => b.length - a.length);
}

function literal(text: string, value: string, placeholder: string): string {
  return text.replace(new RegExp(escapeRe(value), 'gi'), placeholder);
}

function word(text: string, value: string, placeholder: string): string {
  return text.replace(new RegExp(`(?<![\\w-])${escapeRe(value)}(?![\\w-])`, 'gi'), placeholder);
}

function redactSecrets(input: string): string {
  let t = input;
  t = t.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, P.secret);
  t = t.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, P.secret);
  t = t.replace(/github_pat_[A-Za-z0-9_]{20,}/g, P.secret);
  t = t.replace(/sk-[A-Za-z0-9_-]{16,}/g, P.secret);
  t = t.replace(/AKIA[0-9A-Z]{16}/g, P.secret);
  t = t.replace(/xox[abprs]-[A-Za-z0-9-]{10,}/g, P.secret);
  t = t.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, P.secret);
  t = t.replace(/Bearer\s+[^\s<]+/g, `Bearer ${P.secret}`);
  t = t.replace(/\b(token|secret|password|passwd|api[_-]?key|authorization)(\s*[:=]\s*)[^\s<]+/gi, `$1$2${P.secret}`);
  t = t.replace(/[A-Za-z0-9+/=_-]{32,}/g, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? P.secret : run));
  return t;
}

function redactPaths(input: string): string {
  let t = input;
  t = t.replace(/(^|[\s'"(=,[])((?:~|\/)[^\s'"(),[\]<>]*[^\s'"(),[\]<>.:])/g, (_m, lead: string) => `${lead}${P.path}`);
  t = t.replace(/[A-Za-z]:\\[^\s'"<>]+/g, P.path);
  t = t.replace(/[\w.@-]+(?:\/[\w.@-]+)+/g, P.path);
  return t;
}

/** Replace target-identifying strings with fixed placeholders. Idempotent. */
export function redactText(text: string, ctx: RedactionContext = {}): string {
  let t = stripHiddenContent(text);
  if (t === '') return t;

  t = redactSecrets(t);

  t = t.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<]+/gi, (m) => {
    const trail = /[.,;:)\]'"]+$/.exec(m)?.[0] ?? '';
    return P.url + trail;
  });

  t = t.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, P.email);

  const slugs = nonBlank(ctx.repoSlugs);
  for (const slug of byLengthDesc(slugs)) t = literal(t, slug, P.repo);
  const parts: string[] = [];
  for (const slug of slugs) {
    const [owner, name] = slug.split('/');
    for (const p of [name, owner]) if (p && p.length >= 4) parts.push(p);
  }
  for (const p of byLengthDesc(parts)) t = word(t, p, P.repo);

  for (const b of byLengthDesc(nonBlank(ctx.branches))) t = literal(t, b, P.branch);
  const prefixes = factoryBranchPrefixes(ctx.branchPrefix).map(escapeRe).join('|');
  t = t.replace(new RegExp(`\\b(?:${prefixes})/\\d+-[A-Za-z0-9._-]+`, 'g'), P.branch);

  t = redactPaths(t);

  for (const u of byLengthDesc(nonBlank(ctx.usernames))) t = word(t, u, P.user);
  t = t.replace(/(^|\W)@[A-Za-z0-9-]{1,39}\b/g, `$1${P.user}`);

  for (const h of byLengthDesc(nonBlank(ctx.hostnames))) {
    t = literal(t, h, P.host);
    const first = h.split('.')[0];
    if (h.includes('.') && first && first.length >= 4) t = word(t, first, P.host);
  }
  t = t.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, P.host);
  t = t.replace(/\b[\w-]+(?:\.[\w-]+)*\.(?:local|lan|internal|corp|home|localdomain)\b/gi, P.host);

  return t;
}
