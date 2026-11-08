// src/command-output/redact-stream.ts — chunk-to-line reassembly with redaction before emit
import { StringDecoder } from 'node:string_decoder';

import { redactSecrets } from '../router/failure-detail.js';
import { redactGitHubCredentials } from '../utils/github-credentials.js';

const DEFAULT_MAX_LINE_BYTES = 16 * 1024;

function redactLine(line: string): string {
  return redactGitHubCredentials(redactSecrets(line));
}

/** Reassembles raw chunks into lines and emits each line redacted. A token split across
 *  chunks is redacted because only complete lines (or whitespace-bounded flushes) are checked. */
export function createLineRedactor(
  emit: (line: string) => void,
  opts: { maxLineBytes?: number } = {},
): { write(chunk: Uint8Array): void; end(): void } {
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;

  const safeEmit = (text: string): void => {
    try {
      emit(text);
    } catch {
      // a bad consumer must not break framing
    }
  };

  return {
    write(chunk) {
      if (ended) return;
      pending += decoder.write(Buffer.from(chunk));
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl + 1);
        pending = pending.slice(nl + 1);
        safeEmit(redactLine(line.replace(/\r?\n$/, '')));
        nl = pending.indexOf('\n');
      }
      if (pending.length > maxLineBytes) {
        let ws = -1;
        for (let i = pending.length - 1; i >= 0; i--) {
          if (/\s/.test(pending[i])) {
            ws = i;
            break;
          }
        }
        if (ws >= 0) {
          const head = pending.slice(0, ws);
          pending = pending.slice(ws);
          safeEmit(redactLine(head));
        } else {
          safeEmit(`[withheld: ${pending.length} chars without whitespace]`);
          pending = '';
        }
      }
    },
    end() {
      if (ended) return;
      ended = true;
      pending += decoder.end();
      if (pending.length > 0) safeEmit(redactLine(pending));
      pending = '';
    },
  };
}
