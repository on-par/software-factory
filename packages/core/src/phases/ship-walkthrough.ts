// src/phases/ship-walkthrough.ts — best-effort large-PR walkthrough for SHIP (#3623)

import type { EventKind } from '../events/kinds.js';
import {
  meetsWalkthroughThreshold,
  parseNumstat,
  renderPrWalkthrough,
  resolveWalkthroughThresholds,
  type WalkthroughThresholds,
} from '../reports/pr-walkthrough.js';
import type { CheckSummary } from '../types/index.js';
import { computeNumstat } from './ship-diff-stat.js';
import type { CommandRunner } from './ship-git.js';
import { shortDetail } from './ship-git.js';
import { readSpecBody } from './ship-spec.js';

export interface WalkthroughShipOpts {
  specPath?: string;
  checkSummary?: CheckSummary;
  /** pr.walkthrough thresholds (#3623); undefined uses the defaults. */
  walkthrough?: Partial<WalkthroughThresholds>;
  /** The PR's base branch; the size threshold diffs against it, so a stacked PR counts only its own changes. */
  base: string;
}

/** Memoise the PR-base diff for both the walkthrough and the PR proof. */
export function lazyWalkthrough(
  run: CommandRunner,
  worktree: string,
  opts: WalkthroughShipOpts,
  log: (type: EventKind, msg: string) => void,
) {
  let diff: Promise<ReturnType<typeof parseNumstat> | undefined> | undefined;
  const getDiff = () =>
    (diff ??= computeNumstat(run, worktree, opts.base)
      .then(parseNumstat)
      .catch((err: unknown) => {
        log('warn', `walkthrough skipped: ${shortDetail(err)}`);
        return undefined;
      }));
  let built: Promise<string | undefined> | undefined;
  return {
    walkthrough: () =>
      (built ??= getDiff()
        .then(async (files) => {
          if (!files || !meetsWalkthroughThreshold(files, resolveWalkthroughThresholds(opts.walkthrough)))
            return undefined;
          const md = renderPrWalkthrough({
            specBody: await readSpecBody(opts.specPath),
            checkSummary: opts.checkSummary,
          });
          log('evidence', `walkthrough generated (${files.length} files)`);
          return md;
        })
        .catch((err: unknown) => {
          log('warn', `walkthrough skipped: ${shortDetail(err)}`);
          return undefined;
        })),
    counts: async () => {
      const files = await getDiff();
      return files === undefined ? ('unavailable' as const) : typescriptCounts(files);
    },
  };
}

function destination(input: string): string {
  let path = input;
  // Git quotes unusual paths using C escapes, including octal UTF-8 bytes.
  if (path.startsWith('"') && path.endsWith('"')) {
    const bytes: number[] = [];
    const raw = path.slice(1, -1);
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '\\') {
        bytes.push(...Buffer.from(raw[i]));
        continue;
      }
      const octal = /^[0-7]{1,3}/.exec(raw.slice(i + 1))?.[0];
      if (octal) {
        bytes.push(Number.parseInt(octal, 8));
        i += octal.length;
        continue;
      }
      const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
      bytes.push(...Buffer.from(escapes[raw[++i]] ?? raw[i]));
    }
    path = Buffer.from(bytes).toString('utf8');
  }
  return path.replace(/\{[^{}]* => ([^{}]*)\}/g, '$1').replace(/^.* => /, '');
}

function typescriptCounts(files: ReturnType<typeof parseNumstat>): { net: number; nonTest: number } {
  let net = 0;
  let nonTest = 0;
  for (const file of files) {
    const path = destination(file.path);
    if (!/\.tsx?$/.test(path)) continue;
    const change = file.added - file.deleted;
    net += change;
    if (!/(?:^|\/)(?:test|tests|__tests__|__fixtures__)(?:\/|$)/.test(path) && !/\.(?:test|spec)\.tsx?$/.test(path))
      nonTest += change;
  }
  return { net, nonTest };
}
