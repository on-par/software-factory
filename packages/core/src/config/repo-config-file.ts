/** Single reader for the per-repo config file (`.factory/config.yaml|yml|json`). Every loader
 *  goes through `readRepoConfigFile`, so the format decision lives in one place and the Zod
 *  schemas see the same plain object whichever syntax the operator chose. */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { parse as parseYaml, YAMLParseError } from 'yaml';

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
