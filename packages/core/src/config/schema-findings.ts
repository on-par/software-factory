// packages/core/src/config/schema-findings.ts — read-only scan of a config file's raw text for YAML
// syntax errors and schema violations, with 1-based line numbers (#2611). Reuses the exact schema
// checks the two config loaders run.

import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import { factoryRuntimeConfigIssues } from './index.js';
import { repoConfigSchemaIssues } from './repo.js';
import type { ConfigSchemaIssue } from './schema-issue.js';

export interface ConfigSchemaFinding {
  /** Display path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** Dotted path, '(root)' when empty. */
  path: string;
  /** zod or YAML message. */
  message: string;
  kind: 'parse' | 'unknown-key' | 'invalid';
  /** The unknown key, for kind 'unknown-key'. */
  key?: string;
}

/** Line of the node at `path`, falling back to the nearest existing ancestor (line 1 at the root). */
function lineOf(doc: Document, lc: LineCounter, path: readonly (string | number)[]): number {
  let line = 1;
  let node: unknown = doc.contents;
  for (const seg of path) {
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(seg));
      if (!pair || !isScalar(pair.key) || !pair.key.range) break;
      line = lc.linePos(pair.key.range[0]).line;
      node = pair.value;
    } else if (isSeq(node) && typeof seg === 'number') {
      const item = node.items[seg] as { range?: [number, number, number] | null } | undefined;
      if (!item?.range) break;
      line = lc.linePos(item.range[0]).line;
      node = item;
    } else {
      break;
    }
  }
  return line;
}

export function findConfigSchemaErrors(text: string, file: string): ConfigSchemaFinding[] {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    return [
      {
        file,
        line: err.linePos?.[0].line ?? 1,
        path: '(root)',
        message: err.message.split('\n')[0] ?? err.message,
        kind: 'parse',
      },
    ];
  }
  const raw: unknown = doc.toJS();
  // An empty or comment-only file parses to null; doctor does not flag it (neither does the placeholder scan).
  if (raw === null || raw === undefined) return [];

  const seen = new Set<string>();
  const issues: ConfigSchemaIssue[] = [];
  for (const issue of [...repoConfigSchemaIssues(raw), ...factoryRuntimeConfigIssues(raw)]) {
    const id = `${issue.path.join('.')}\u0000${issue.message}\u0000${(issue.keys ?? []).join(',')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    issues.push(issue);
  }

  const findings: ConfigSchemaFinding[] = [];
  for (const issue of issues) {
    const path = issue.path.join('.') || '(root)';
    if (issue.keys?.length) {
      for (const key of issue.keys) {
        findings.push({
          file,
          line: lineOf(doc, lc, [...issue.path, key]),
          path,
          message: issue.message,
          kind: 'unknown-key',
          key,
        });
      }
    } else {
      findings.push({ file, line: lineOf(doc, lc, issue.path), path, message: issue.message, kind: 'invalid' });
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.path.localeCompare(b.path));
}
