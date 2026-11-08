// packages/core/src/command-output/redactor.ts — line-buffering stream redactor (#3994)
import { StringDecoder } from 'node:string_decoder';

import { redactSecrets } from '../filing/redact.js';
import { redactGitHubCredentials } from '../utils/github-credentials.js';

export interface StreamRedactor {
  push(chunk: Buffer | string): string[];
  end(): string[];
}

const SECRET = '<secret>';
const KEY_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
const TOKEN_CHAR = /[A-Za-z0-9_+/=.-]/;
const DEFAULT_MAX_PENDING = 16384;

/** Redacts complete lines of a child's output as they arrive, holding a partial line until its newline so a
 *  secret split across chunks (or a UTF-8 boundary) is masked whole. Reuses the existing credential patterns. */
export function createStreamRedactor(
  options: { env?: Record<string, string | undefined>; maxPendingChars?: number } = {},
): StreamRedactor {
  const env = options.env ?? process.env;
  const maxPending = options.maxPendingChars ?? DEFAULT_MAX_PENDING;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let inKey = false;

  const redactLine = (line: string): string => redactSecrets(redactGitHubCredentials(line, env));

  const emitLine = (line: string, out: string[]): void => {
    if (inKey) {
      if (KEY_END.test(line)) inKey = false;
      return;
    }
    if (KEY_BEGIN.test(line)) {
      inKey = true;
      out.push(`${SECRET}\n`);
      return;
    }
    out.push(redactLine(line));
  };

  const emitOversized = (out: string[]): void => {
    if (pending.length <= maxPending) return;
    let idx = -1;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (!TOKEN_CHAR.test(pending[i])) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      if (!inKey) out.push(SECRET);
      pending = '';
      return;
    }
    const head = pending.slice(0, idx + 1);
    pending = pending.slice(idx + 1);
    if (inKey) return;
    if (KEY_BEGIN.test(head)) {
      inKey = true;
      out.push(SECRET);
      return;
    }
    out.push(redactLine(head));
  };

  const drain = (out: string[]): void => {
    let nl = pending.indexOf('\n');
    while (nl >= 0) {
      const line = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      emitLine(line, out);
      nl = pending.indexOf('\n');
    }
    emitOversized(out);
  };

  return {
    push(chunk) {
      const out: string[] = [];
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      drain(out);
      return out;
    },
    end() {
      const out: string[] = [];
      pending += decoder.end();
      const rest = pending;
      pending = '';
      if (rest === '' || inKey) return out;
      if (KEY_BEGIN.test(rest)) {
        inKey = true;
        out.push(SECRET);
        return out;
      }
      out.push(redactLine(rest));
      return out;
    },
  };
}
