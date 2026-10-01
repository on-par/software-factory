/** Single reader for the per-repo config file (`.factory/config.yaml|yml|json`). Every loader
 *  goes through `readRepoConfigFile`, so the format decision lives in one place and the Zod
 *  schemas see the same plain object whichever syntax the operator chose. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { Document, isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml, YAMLParseError } from 'yaml';

/** Repo config file names in preference order. */
export const REPO_CONFIG_FILENAMES = ['config.yaml', 'config.yml', 'config.json'] as const;

/** Path of the repo config file under `root` (`.factory/`): the first existing candidate,
 *  else `<root>/config.yaml`. Never throws — ambiguity is reported by `readRepoConfigFile`. */
export function resolveRepoConfigPath(root: string): string {
  for (const name of REPO_CONFIG_FILENAMES) {
    const candidate = join(root, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(root, 'config.yaml');
}

/** Read and parse the repo config file. Returns `undefined` when the file is absent. Throws
 *  when more than one candidate config file exists beside it, or when the text is malformed
 *  (the message names the file, plus the line for YAML). Validation stays with the caller. */
export function readRepoConfigFile(configPath: string): unknown {
  if (!existsSync(configPath)) return undefined;

  if ((REPO_CONFIG_FILENAMES as readonly string[]).includes(basename(configPath))) {
    const dir = dirname(configPath);
    const present = REPO_CONFIG_FILENAMES.map((name) => join(dir, name)).filter((p) => existsSync(p));
    if (present.length > 1) {
      throw new Error(
        `Multiple repo config files found: ${present.join(' and ')}. Keep only one (config.yaml is preferred).`,
      );
    }
  }

  const text = readFileSync(configPath, 'utf-8');
  const ext = extname(configPath);
  if (ext === '.yaml' || ext === '.yml') {
    try {
      return parseYaml(text);
    } catch (err) {
      if (err instanceof YAMLParseError) {
        throw new Error(`Failed to parse ${configPath} (line ${err.linePos?.[0]?.line ?? '?'}): ${err.message}`);
      }
      throw err;
    }
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Failed to parse ${configPath}: ${(err as Error).message}`);
  }
}

/** Header comment written at the top of a freshly created `config.yaml`. */
export const REPO_CONFIG_YAML_HEADER =
  '# Software Factory repo config. Every key is documented in docs/config.example.yaml.\n';

function isYamlPath(p: string): boolean {
  const ext = extname(p);
  return ext === '.yaml' || ext === '.yml';
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Set one key in the repo config file, in that file's own format. YAML is edited in place
 *  through the Document API so comments, blank lines and key order survive; JSON is rewritten
 *  as two-space JSON. An absent file is created holding `{ version: 2 }` plus the key. */
export function setRepoConfigValue(configPath: string, keyPath: readonly string[], value: unknown): void {
  if (isYamlPath(configPath)) {
    let doc: Document;
    if (existsSync(configPath)) {
      doc = parseDocument(readFileSync(configPath, 'utf-8'));
      if (doc.errors.length > 0) throw new Error(`Failed to parse ${configPath}: ${doc.errors[0]!.message}`);
    } else {
      doc = new Document({ version: 2 });
      doc.commentBefore = REPO_CONFIG_YAML_HEADER.replace(/^#/, '').replace(/\n$/, '');
    }
    if (doc.contents === null || !isMap(doc.contents)) doc.contents = doc.createNode({ version: 2 });
    for (let i = 1; i < keyPath.length; i++) {
      const prefix = keyPath.slice(0, i);
      if (!isMap(doc.getIn(prefix, true))) doc.setIn(prefix, doc.createNode({}));
    }
    doc.setIn(keyPath, value);
    writeAtomic(configPath, doc.toString());
    return;
  }

  const raw = readRepoConfigFile(configPath) ?? { version: 2 };
  if (!isObject(raw)) throw new Error(`Invalid ${configPath}: expected a JSON object`);
  const next: Record<string, unknown> = { ...raw };
  let cursor = next;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const key = keyPath[i]!;
    const existing = cursor[key];
    const cloned: Record<string, unknown> = isObject(existing) ? { ...existing } : {};
    cursor[key] = cloned;
    cursor = cloned;
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
  writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
}

export type RepoConfigYamlMigration =
  | { status: 'migrated'; from: string; to: string }
  | { status: 'would-migrate'; from: string; to: string }
  | { status: 'already-yaml'; path: string }
  | { status: 'no-config' }
  | { status: 'round-trip-failed'; from: string; reason: string };

/** Convert `<root>/config.json` to `<root>/config.yaml`. The JSON is removed only after the
 *  written YAML parses back deep-equal to it; otherwise the YAML is removed and the JSON kept.
 *  `parse` is a test seam for the read-back. */
export function migrateRepoConfigToYaml(
  root: string,
  options: { dryRun?: boolean; parse?: (text: string) => unknown } = {},
): RepoConfigYamlMigration {
  const jsonPath = join(root, 'config.json');
  const yamlPath = join(root, 'config.yaml');
  const ymlPath = join(root, 'config.yml');
  if (!existsSync(jsonPath)) {
    if (existsSync(yamlPath)) return { status: 'already-yaml', path: yamlPath };
    if (existsSync(ymlPath)) return { status: 'already-yaml', path: ymlPath };
    return { status: 'no-config' };
  }
  const value = readRepoConfigFile(jsonPath);
  if (options.dryRun) return { status: 'would-migrate', from: jsonPath, to: yamlPath };

  writeAtomic(yamlPath, REPO_CONFIG_YAML_HEADER + stringifyYaml(value));
  let failure: string | undefined;
  try {
    const readBack = (options.parse ?? parseYaml)(readFileSync(yamlPath, 'utf-8'));
    if (!isDeepStrictEqual(readBack, value)) failure = 'YAML read-back differs from config.json';
  } catch (err) {
    failure = (err as Error).message;
  }
  if (failure !== undefined) {
    rmSync(yamlPath, { force: true });
    return { status: 'round-trip-failed', from: jsonPath, reason: failure };
  }
  rmSync(jsonPath);
  return { status: 'migrated', from: jsonPath, to: yamlPath };
}
