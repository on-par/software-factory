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

/** Scans a unified git diff for suppression comments (added lines) and protected paths (any file header). */
export function scanReworkDiff(diff: string): CiSuppressionFinding[] {
  const findings: CiSuppressionFinding[] = [];
  const seen = new Set<string>();
  const add = (f: CiSuppressionFinding): void => {
    const key = `${f.kind}|${f.rule}|${f.file}|${f.line ?? ''}|${f.kind === 'path' ? f.match : ''}`;
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
  for (const raw of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (header) {
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
      if (line !== undefined) line++;
    } else if (raw.startsWith(' ') && line !== undefined) {
      line++;
    }
  }
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
