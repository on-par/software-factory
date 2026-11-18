import type { Octokit } from '@octokit/rest';
import { findDeclaredPrerequisites } from '@on-par/factory-core/internal';

import { readPrerequisiteState } from './queue-prerequisite-state.js';
import type { RunReportSink } from './run-report.js';

export async function findOpenPrerequisites(
  brief: string,
  isOpen: (issue: number) => Promise<boolean>,
  warn: (message: string) => void,
): Promise<number[]> {
  const open: number[] = [];
  for (const issue of findDeclaredPrerequisites(brief)) {
    try {
      if (await isOpen(issue)) open.push(issue);
    } catch (err) {
      warn(`prerequisite #${issue} lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return open;
}

export interface PrerequisiteParkInput {
  brief: string;
  repo: string;
  octokit: () => Octokit;
  report: Pick<RunReportSink, 'recordPrerequisites' | 'recordLifecycle'>;
  log: (type: 'warn' | 'issue_deferred', message: string) => void;
}

export async function parkOnOpenPrerequisites(input: PrerequisiteParkInput): Promise<boolean> {
  const [owner = '', name = ''] = input.repo.split('/');
  const open = await findOpenPrerequisites(
    input.brief,
    async (n) => (await readPrerequisiteState(input.octokit(), owner, name, n)).state === 'open',
    (message) => input.log('warn', message),
  );
  if (open.length === 0) return false;
  const detail = `waiting for prerequisites: ${open.map((n) => `#${n}`).join(', ')}`;
  input.log('issue_deferred', detail);
  input.report.recordPrerequisites(open);
  input.report.recordLifecycle({ outcome: 'parked', detail });
  return true;
}
