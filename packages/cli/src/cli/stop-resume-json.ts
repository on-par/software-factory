import type { StopResumeJson } from './json-contract.js';

export type { StopResumeJson } from './json-contract.js';

/** `factory stop|resume --json` payload (#2276). Additive changes only; bump schemaVersion on a breaking change. */

export function buildStopResumeJson(input: {
  action: 'stop' | 'resume';
  repo: string;
  before: boolean;
  after: boolean;
}): StopResumeJson {
  return {
    schemaVersion: 1,
    ok: true,
    action: input.action,
    repo: input.repo,
    stopFlag: { before: input.before, after: input.after },
  };
}
