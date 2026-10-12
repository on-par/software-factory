// src/utils/opencode-config.ts — answers "is the opencode CLI logged in?" without any inference call.
//
// A leaf module: node built-ins only. `opencode auth login` stores credentials in
// `<XDG data dir>/opencode/auth.json`; reading it makes no model request, so it costs no quota (#2461).

import { readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

export interface OpencodeLoginEvidenceDeps {
  env?: NodeJS.ProcessEnv;
  /** Home directory. Default: os.homedir(). */
  homedir?: () => string;
  /** Reads a file as utf8, throws when missing. Default: readFileSync(path, 'utf8'). */
  readFile?: (path: string) => string;
}

/** True when the opencode CLI has stored credentials, found without any inference call (#2461).
 *  Evidence: `<XDG_DATA_HOME or ~/.local/share>/opencode/auth.json` parses to a JSON object with at
 *  least one entry (written by `opencode auth login`). Never throws. */
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
