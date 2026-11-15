import { readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface OpencodeLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  readFile?: (path: string) => string;
}

export function hasOpencodeLoginEvidence(deps: OpencodeLoginEvidenceDeps = {}): boolean {
  const env = deps.env ?? process.env;
  const homedir = deps.homedir ?? osHomedir;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  try {
    const dataDir = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
    const parsed: unknown = JSON.parse(readFile(join(dataDir, 'opencode', 'auth.json')));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length > 0;
  } catch {
    return false;
  }
}
