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
  walkthrough?: Partial<WalkthroughThresholds>;
  base: string;
}

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

function unquoteGitCEscapedPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"'))) return path;
  const bytes: number[] = [];
  const raw = path.slice(1, -1);
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') {
      bytes.push(...Buffer.from(raw[i]));
      continue;
    }
    const octalUtf8Byte = /^[0-7]{1,3}/.exec(raw.slice(i + 1))?.[0];
    if (octalUtf8Byte) {
      bytes.push(Number.parseInt(octalUtf8Byte, 8));
      i += octalUtf8Byte.length;
      continue;
    }
    const escapes: Record<string, string> = { t: '\t', n: '\n', r: '\r', '"': '"', '\\': '\\' };
    bytes.push(...Buffer.from(escapes[raw[++i]] ?? raw[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}

function destination(input: string): string {
  return unquoteGitCEscapedPath(input)
    .replace(/\{[^{}]* => ([^{}]*)\}/g, '$1')
    .replace(/^.* => /, '');
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
