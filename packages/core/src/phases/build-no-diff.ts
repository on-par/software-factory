import { stripVTControlCharacters } from 'node:util';

import { redactText } from '../filing/redact.js';

export type NoDiffCause = 'sandbox' | 'open-questions' | 'unknown';

export interface NoDiffDiagnostics {
  noDiffCause?: NoDiffCause;
  workerOutputTail?: string;
}

export function classifyNoDiff(opts: { output: string; openQuestions?: readonly string[] }): NoDiffCause {
  const output = stripVTControlCharacters(opts.output);
  if (/Operation not permitted|sandbox_apply|sandbox denied|\b(?:EPERM|EACCES)\b/i.test(output)) return 'sandbox';
  if ((opts.openQuestions?.length ?? 0) > 0) return 'open-questions';
  return 'unknown';
}

export function workerOutputTail(output: string): string {
  const sanitized = redactText(stripVTControlCharacters(output));
  const lines = sanitized.split(/\r\n|\n|\r/).filter((line) => line.trim().length > 0);
  return lines.slice(-20).join('\n').slice(-2000);
}

export function describeNoDiffFailure(opts: {
  output: string;
  openQuestions?: readonly string[];
  baseRef: string;
  excludedPaths?: readonly string[];
}): NoDiffDiagnostics & { reason: 'no_diff' | 'junk_only_diff'; detail: string } {
  const junkOnly = (opts.excludedPaths?.length ?? 0) > 0;
  const reason = junkOnly ? 'junk_only_diff' : 'no_diff';
  const detail = junkOnly
    ? `worker changed only generated/cache files against ${opts.baseRef} (${opts.excludedPaths!.slice(0, 10).join(', ')}); no implementation was produced`
    : `worker produced no diff against ${opts.baseRef}; no implementation was produced`;
  const tail = workerOutputTail(opts.output);
  const noDiffCause = junkOnly ? undefined : classifyNoDiff(opts);
  const diagnosticDetail = [
    detail,
    noDiffCause ? `cause: ${noDiffCause}` : undefined,
    tail ? `Worker output (last lines):\n${tail}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join('\n');
  return {
    reason,
    detail: diagnosticDetail,
    ...(noDiffCause ? { noDiffCause } : {}),
    workerOutputTail: tail,
  };
}

export function formatNoDiffParkMessage(
  build: NoDiffDiagnostics & { reason?: 'no_diff' | 'junk_only_diff' },
  openQuestions?: readonly string[],
): string {
  const isJunkOnly = build.reason === 'junk_only_diff';
  const parts = [
    isJunkOnly
      ? 'build changed only generated/cache files (e.g. __pycache__) — no implementation was produced'
      : 'build produced no diff against the base ref — no implementation was produced',
  ];
  if (!isJunkOnly) parts.push(`cause: ${build.noDiffCause ?? 'unknown'}`);
  if (!isJunkOnly && build.noDiffCause === 'open-questions' && openQuestions?.length) {
    const questions = openQuestions.slice(0, 3).map((question) => redactText(stripVTControlCharacters(question)));
    parts.push(`Open plan questions:\n${questions.map((question) => `- ${question}`).join('\n')}`);
  }
  if (build.workerOutputTail) parts.push(`Worker output (last lines):\n${build.workerOutputTail}`);
  return parts.join('\n\n');
}
