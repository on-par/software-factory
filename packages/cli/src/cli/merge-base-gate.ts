import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventKind } from '@on-par/factory-core';
import type { RequiredChecksVerdict } from '@on-par/factory-core/internal';

export class BaseCiPendingError extends Error {
  prNumber?: number;
}

const MISSING_CONTEXT_GRACE_MS = 2 * 60_000;

type RecordState = { repo: string; merge: string; paused?: boolean };
type Options = {
  file: string;
  repo: string;
  head: () => Promise<string>;
  verdict: (sha: string) => Promise<RequiredChecksVerdict>;
  descends?: (merge: string, head: string) => Promise<boolean>;
  log: (kind: EventKind, message: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function createMergeBaseGate(opts: Options) {
  const read = (): RecordState | undefined => {
    try {
      const value: unknown = JSON.parse(readFileSync(opts.file, 'utf8'));
      if (typeof value !== 'object' || value === null) return undefined;
      const entry = (value as Record<string, RecordState>)[opts.repo];
      return entry?.repo === opts.repo && typeof entry.merge === 'string' ? entry : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (entry: RecordState): void => {
    let all: Record<string, RecordState> = {};
    try {
      all = JSON.parse(readFileSync(opts.file, 'utf8')) as Record<string, RecordState>;
    } catch {
      all = {};
    }
    mkdirSync(dirname(opts.file), { recursive: true });
    writeFileSync(opts.file, `${JSON.stringify({ ...all, [opts.repo]: entry }, null, 2)}\n`);
  };
  const warned = new Set<string>();
  const once = async (graceOver: boolean): Promise<boolean> => {
    let sha: string;
    let verdict: RequiredChecksVerdict;
    try {
      sha = await opts.head();
      verdict = await opts.verdict(sha);
    } catch (err) {
      throw new BaseCiPendingError(`base CI lookup failed: ${String(err)}`);
    }
    const entry = read();
    if (verdict.green) {
      if (entry?.paused) {
        write({ ...entry, paused: false });
        opts.log('red-main-cleared', `base CI green; merge pause cleared for ${entry.merge}`);
      }
      return true;
    }
    if (entry?.paused) throw new BaseCiPendingError(`base merge pause for ${entry.merge}: ${verdict.reason}`);
    if (verdict.noCodeHealthChecks) return true;
    if (verdict.state === 'pending' && verdict.missing?.length) {
      if (!graceOver) return false;
      if (!warned.has(sha)) {
        warned.add(sha);
        opts.log(
          'warn',
          `base CI: required check(s) ${verdict.missing.join(', ')} have no run on ${sha.slice(0, 8)}; base has no hosted code-health signal, merging without the base CI gate`,
        );
      }
      return true;
    }
    if (verdict.state === 'failed') {
      let related = entry?.merge === sha;
      if (entry && !related) {
        try {
          related = (await opts.descends?.(entry.merge, sha)) === true;
        } catch (err) {
          throw new BaseCiPendingError(`base ancestry lookup failed: ${String(err)}`);
        }
      }
      if (entry && related && !read()?.paused) {
        write({ ...entry, paused: true });
        opts.log('red-main', `base CI failed after merge ${entry.merge}: ${verdict.reason}`);
      }
      throw new BaseCiPendingError(`base CI failed on ${sha}: ${verdict.reason}`);
    }
    return false;
  };
  const check = async (wait = true): Promise<void> => {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const start = now();
    const deadline = start + 30 * 60_000;
    let delay = 5_000;
    for (;;) {
      if (await once(!wait || now() - start >= MISSING_CONTEXT_GRACE_MS)) return;
      if (!wait || now() >= deadline) throw new BaseCiPendingError('base CI is pending; leaving PR open');
      await sleep(Math.min(delay, deadline - now()));
      delay = Math.min(delay * 2, 60_000);
    }
  };
  return { check, record: (merge: string) => write({ repo: opts.repo, merge }) };
}
