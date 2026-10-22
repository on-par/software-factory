// packages/core/src/config/config-schema-lint.ts — doctor-only schema check for the repo config file (#2611); the run loaders already throw on these.
// Reads through readRepoConfigFile (ADR-0119), so a file the loaders reject is never passed here.
import { existsSync, readFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, LineCounter, parseDocument, YAMLParseError, type Document } from 'yaml';
import { factoryRuntimeConfigIssues, isPlainObject, type ConfigSchemaIssue } from './index.js';
import { readRepoConfigFile } from './repo-config-file.js';
import { repoRoutingConfigIssues } from './repo.js';

export interface ConfigSchemaFinding {
  /** Display path (relPath). */
  file: string;
  /** 1-based line, YAML only. */
  line?: number;
  /** Dotted key path, `(root)` or `(syntax)`. */
  path: string;
  /** Zod message, `unknown key '<k>'`, or the parse error. */
  message: string;
  fix: string;
}

const EXAMPLE = 'see docs/config.example.yaml';

function yamlLineForPath(doc: Document, lc: LineCounter, path: (string | number)[]): number | undefined {
  let node: unknown = doc.contents;
  let line: number | undefined;
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
  if (line === undefined && !isMap(doc.contents)) return 1;
  return line;
}

/** Schema errors in the repo config file as findings with file:line and a fix. Read-only; mirrors the loaders. */
export function findConfigSchemaErrors(configFile: { absPath: string; relPath: string }): ConfigSchemaFinding[] {
  const { absPath, relPath } = configFile;
  if (!existsSync(absPath)) return [];
  const isYaml = /\.ya?ml$/i.test(absPath);

  let raw: unknown;
  try {
    raw = readRepoConfigFile(absPath);
  } catch (err) {
    const message = (err as Error).message;
    const cause = (err as Error).cause;
    if (cause instanceof YAMLParseError) {
      return [{ file: relPath, line: cause.linePos?.[0]?.line, path: '(syntax)', message, fix: 'fix the YAML syntax' }];
    }
    if (cause !== undefined) return [{ file: relPath, path: '(syntax)', message, fix: 'fix the JSON syntax' }];
    return [
      { file: relPath, path: '(file)', message, fix: 'keep only one repo config file (config.yaml is preferred)' },
    ];
  }

  // Already parsed cleanly by the shared reader; the Document is only for line mapping.
  const lc = new LineCounter();
  const doc: Document | undefined = isYaml
    ? parseDocument(readFileSync(absPath, 'utf8').replace(/^\uFEFF/, ''), { lineCounter: lc })
    : undefined;

  if (raw === null || raw === undefined) {
    return [
      {
        file: relPath,
        line: isYaml ? 1 : undefined,
        path: '(root)',
        message: 'the file is empty or only comments; expected a mapping of config keys',
        fix: `add config keys (${EXAMPLE}) or delete the file to use the defaults`,
      },
    ];
  }
  if (!isPlainObject(raw)) {
    return [
      {
        file: relPath,
        line: isYaml ? 1 : undefined,
        path: '(root)',
        message: 'expected a mapping',
        fix: 'make the file a YAML mapping of config keys',
      },
    ];
  }

  const issues: ConfigSchemaIssue[] = [...factoryRuntimeConfigIssues(raw), ...repoRoutingConfigIssues(raw)];
  const findings: ConfigSchemaFinding[] = [];
  const seen = new Set<string>();
  const add = (segs: (string | number)[], message: string, fix: (dotted: string) => string) => {
    const dotted = segs.join('.') || '(root)';
    const key = `${dotted}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const line = doc ? yamlLineForPath(doc, lc, segs) : undefined;
    findings.push({ file: relPath, ...(line !== undefined ? { line } : {}), path: dotted, message, fix: fix(dotted) });
  };
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const k of issue.keys ?? []) {
        add(
          [...issue.path, k],
          `unknown key '${k}'`,
          (d) => `remove '${d}' or rename it to a supported key (${EXAMPLE})`,
        );
      }
    } else {
      add(issue.path, issue.message, (d) => `set '${d}' to a valid value (${EXAMPLE})`);
    }
  }
  return findings;
}
