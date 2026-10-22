// packages/core/src/run/ci-suppression-guard.ts — mechanical suppression guard for SHIP CI rework diffs (#2818)

import type { CiSuppressionFinding } from '../types/index.js';
import { execGit } from '../utils/git-exec.js';

export const SUPPRESSION_ATTEMPT = 'suppression-attempt';

const MAX_MATCH = 200;
const MAX_LISTED = 5;

interface CommentRule {
  rule: string;
  test: (line: string) => boolean;
}

/** True when an eslint-disable directive in `line` is blanket or names a security rule. */
function eslintDisablesSecurity(line: string): boolean {
  const m = /eslint-disable(?:-next-line|-line)?(?![\w-])([^\n]*)/.exec(line);
  if (!m) return false;
  let list = m[1];
  const dash = list.indexOf('--');
  if (dash >= 0) list = list.slice(0, dash);
  const end = list.indexOf('*/');
  if (end >= 0) list = list.slice(0, end);
  const rules = list.split(/[,\s]+/).filter(Boolean);
  return rules.length === 0 || rules.some((r) => /security/i.test(r));
}

/** Added-line rules; the single owner of the known suppression comment forms. */
const SUPPRESSION_COMMENT_RULES: CommentRule[] = [
  { rule: 'codeql-comment', test: (l) => /\bcodeql\[/i.test(l) },
  { rule: 'lgtm-comment', test: (l) => /(?:\/\/|#|\/\*|\*|<!--|--).*\blgtm\b/i.test(l) },
  { rule: 'nosec-comment', test: (l) => /#\s*nosec\b/i.test(l) || /\/\/\s*#?nosec\b/i.test(l) },
  { rule: 'eslint-disable-security', test: eslintDisablesSecurity },
];

function pathRules(path: string): string[] {
  const segments = path.split('/');
  const base = segments[segments.length - 1];
  const rules: string[] = [];
  if (path.startsWith('.github/workflows/')) rules.push('workflow-path');
  if (segments.slice(0, -1).some((s) => /^\.?codeql$/i.test(s)) || /codeql.*\.(ya?ml|json)$/i.test(base)) {
    rules.push('codeql-path');
  }
  if (/\.sarif(\.json)?$/i.test(base)) rules.push('sarif-path');
  return rules;
}

const MAX_LINES_ENTRY = /^\s*"(.+)"\s*:\s*(\d+)\s*,?\s*$/;
const VITEST_CONFIG = /^vitest\.config\.[cm]?[jt]s$/;
const THRESHOLD = /\b(lines|functions|branches|statements)\s*:\s*(\d+(?:\.\d+)?)/g;

function thresholds(text: string): [string, number][] {
  return [...text.matchAll(THRESHOLD)].map((m) => [m[1], Number(m[2])]);
}

/**
 * Scans a unified git diff for suppression comments (added lines), protected paths (any file header)
 * and ratchet tampering: a raised max-lines-baseline.json ceiling or a lowered vitest coverage threshold (#3537).
 */
export function scanReworkDiff(diff: string): CiSuppressionFinding[] {
  const findings: CiSuppressionFinding[] = [];
  const seen = new Set<string>();
  const add = (f: CiSuppressionFinding): void => {
    const key = `${f.kind}|${f.rule}|${f.file}|${f.line ?? ''}|${f.kind === 'comment' ? '' : f.match}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(f);
  };
  const checkPath = (path: string): void => {
    if (!path || path === '/dev/null') return;
    for (const rule of pathRules(path)) add({ kind: 'path', rule, file: path, match: path });
  };

  let file = '(unknown)';
  let line: number | undefined;
  let inHunk = false;
  const basename = (): string => file.split('/').pop() ?? file;
  let baselineRemoved = new Map<string, number>();
  let baselineAdded: [string, number][] = [];
  let hunkRemoved: string[] = [];
  let hunkAdded: { text: string; line: number | undefined }[] = [];
  const flushHunk = (): void => {
    if (VITEST_CONFIG.test(basename())) {
      const removed = thresholds(hunkRemoved.join('\n'));
      const addedByKey = new Map<string, number[]>();
      for (const [key, value] of thresholds(hunkAdded.map((a) => a.text).join('\n'))) {
        addedByKey.set(key, [...(addedByKey.get(key) ?? []), value]);
      }
      const used = new Map<string, number>();
      const hitLine = hunkAdded[0]?.line;
      for (const [key, old] of removed) {
        const idx = used.get(key) ?? 0;
        used.set(key, idx + 1);
        const next = addedByKey.get(key)?.[idx];
        if (next === undefined || next < old) {
          add({
            kind: 'ratchet',
            rule: 'coverage-threshold',
            file,
            ...(hitLine !== undefined ? { line: hitLine } : {}),
            match: `${key} ${old} -> ${next ?? 'removed'}`,
          });
        }
      }
    }
    hunkRemoved = [];
    hunkAdded = [];
  };
  const flushFile = (): void => {
    flushHunk();
    if (basename() === 'max-lines-baseline.json') {
      for (const [key, n] of baselineAdded) {
        const old = baselineRemoved.get(key);
        if (old === undefined || n > old) {
          add({ kind: 'ratchet', rule: 'max-lines-ceiling', file, match: `"${key}" ${old ?? 'new'} -> ${n}` });
        }
      }
    }
    baselineRemoved = new Map();
    baselineAdded = [];
  };
  for (const raw of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header) {
      flushFile();
      inHunk = false;
      line = undefined;
      file = header[2];
      checkPath(header[1]);
      checkPath(header[2]);
      continue;
    }
    if (!inHunk) {
      const rename = /^rename (?:from|to) (.+)$/.exec(raw);
      if (rename) {
        checkPath(rename[1]);
        continue;
      }
      const oldPath = /^--- (?:a\/)?(.+)$/.exec(raw);
      if (oldPath) {
        checkPath(oldPath[1]);
        continue;
      }
      const newPath = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
      if (newPath) {
        if (newPath[1] !== '/dev/null') file = newPath[1];
        checkPath(newPath[1]);
        continue;
      }
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      flushHunk();
      inHunk = true;
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      for (const { rule, test } of SUPPRESSION_COMMENT_RULES) {
        if (test(text)) {
          add({
            kind: 'comment',
            rule,
            file,
            ...(line !== undefined ? { line } : {}),
            match: text.trim().slice(0, MAX_MATCH),
          });
        }
      }
      hunkAdded.push({ text, line });
      const entry = MAX_LINES_ENTRY.exec(text);
      if (entry) baselineAdded.push([entry[1], Number(entry[2])]);
      if (line !== undefined) line++;
    } else if (inHunk && raw.startsWith('-')) {
      const text = raw.slice(1);
      hunkRemoved.push(text);
      const entry = MAX_LINES_ENTRY.exec(text);
      if (entry) baselineRemoved.set(entry[1], Number(entry[2]));
    } else if (raw.startsWith(' ') && line !== undefined) {
      line++;
    }
  }
  flushFile();
  return findings;
}

/** Reads the worktree's current HEAD SHA. */
export async function readWorktreeHead(worktree: string): Promise<string> {
  const { stdout } = await execGit(['rev-parse', 'HEAD'], { cwd: worktree });
  const sha = stdout.trim();
  if (!sha) throw new Error('git rev-parse HEAD returned nothing');
  return sha;
}

/** Reads the committed diff from `fromSha` to HEAD (SHIP re-entry pushes HEAD, not the working tree). */
export async function readReworkDiff(worktree: string, fromSha: string): Promise<string> {
  const { stdout } = await execGit(['diff', '--no-color', '--no-ext-diff', '--unified=0', fromSha, 'HEAD'], {
    cwd: worktree,
  });
  return stdout;
}

/** One-line summary of guard findings for park messages and logs. */
export function describeSuppression(findings: readonly CiSuppressionFinding[]): string {
  const items = findings.slice(0, MAX_LISTED).map((f) => {
    if (f.kind === 'comment') return `${f.rule} at ${f.file}${f.line !== undefined ? `:${f.line}` : ''}`;
    return `${f.rule} ${f.match}`;
  });
  const more = findings.length > MAX_LISTED ? `, +${findings.length - MAX_LISTED} more` : '';
  return `${SUPPRESSION_ATTEMPT}: ${findings.length} finding(s): ${items.join(', ')}${more}`;
}

export type BaseMergeResult =
  | { ok: true; merged: boolean }
  | { ok: false; conflict: true; paths: string[] }
  | { ok: false; conflict: false; message: string };

const gitMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Fetches origin/<baseRef> and merges it into the worktree branch without pushing (#3537). A conflict
 * is aborted and reported with its paths; any other failure is reported as a message. Never throws.
 */
export async function mergeBaseIntoWorktree(worktree: string, baseRef: string): Promise<BaseMergeResult> {
  const opts = { cwd: worktree };
  let before: string;
  try {
    await execGit(['fetch', 'origin', baseRef], opts);
    before = (await execGit(['rev-parse', 'HEAD'], opts)).stdout.trim();
  } catch (err) {
    return { ok: false, conflict: false, message: gitMessage(err) };
  }
  try {
    await execGit(['merge', '--no-edit', `origin/${baseRef}`], opts);
    const after = (await execGit(['rev-parse', 'HEAD'], opts)).stdout.trim();
    return { ok: true, merged: after !== before };
  } catch (err) {
    let paths: string[] = [];
    try {
      const { stdout } = await execGit(['diff', '--name-only', '--diff-filter=U'], opts);
      paths = stdout.split('\n').filter(Boolean);
    } catch {
      // fall through to a non-conflict failure
    }
    if (paths.length === 0) return { ok: false, conflict: false, message: gitMessage(err) };
    await execGit(['merge', '--abort'], opts).catch(() => undefined);
    return { ok: false, conflict: true, paths };
  }
}
