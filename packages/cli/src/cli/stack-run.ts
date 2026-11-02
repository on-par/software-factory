// packages/cli/src/cli/stack-run.ts — the CLI side of the stack engine: console output and the run-issue --stack slice list (#3798)

import { styleText } from 'node:util';

import { runStack, type RunOutcome, type StackLogLevel, type StackRunResult } from '@on-par/factory-core';
import type { BlockedByItem, SlicePlan } from '@on-par/factory-core/internal';

import { CliExitError } from './errors.js';

export function consoleStackLog(level: StackLogLevel, line: string): void {
  if (level === 'error') console.error(styleText('red', line));
  else console.log(styleText(level === 'warn' ? 'yellow' : 'cyan', line));
}

/** Prints the engine's summary (green when every slice succeeded, yellow otherwise) and throws exit 1 on failure. */
export function printStackResult(result: StackRunResult, failMessage: string): void {
  for (const line of result.summary) {
    console.log(result.ok ? styleText('green', line) : styleText('yellow', line));
  }
  if (!result.ok) throw new CliExitError(failMessage, 1);
}

export interface SliceStackDeps {
  /** The issue's slice plan, or undefined when no valid slice-plan comment exists. */
  readSlicePlan: () => Promise<SlicePlan | undefined>;
  /** One shipIssue run with sizeGate 'stack' and baseBranch = base; throws when the run fails or parks. */
  ship: (base: string | undefined, onOutcome: (outcome: RunOutcome) => void) => Promise<void>;
}

export interface IssueStackDeps extends SliceStackDeps {
  repo: string;
  list: (issue: number) => Promise<BlockedByItem[]>;
  shipMember: (issue: number, base: string | undefined, onOutcome: (outcome: RunOutcome) => void) => Promise<void>;
}

export async function orderIssueChain(
  target: number,
  repo: string,
  list: (issue: number) => Promise<BlockedByItem[]>,
): Promise<number[]> {
  const active = new Set<number>();
  const completed = new Set<number>();
  const path: number[] = [];
  const ordered: number[] = [];
  async function visit(issue: number): Promise<void> {
    if (active.has(issue)) {
      const cycle = [...path.slice(path.indexOf(issue)), issue].map((n) => `#${n}`).join(' → ');
      throw new CliExitError(`factory: blocked-by cycle: ${cycle}`, 2);
    }
    if (completed.has(issue)) return;
    active.add(issue);
    path.push(issue);
    for (const item of await list(issue)) {
      if (item.state === 'open' && item.repository.toLowerCase() === repo.toLowerCase()) await visit(item.number);
    }
    path.pop();
    active.delete(issue);
    completed.add(issue);
    ordered.push(issue);
  }
  await visit(target);
  return ordered;
}

/** `run-issue --stack` (#3798): sizes the issue when it has no slice plan yet, then builds every pending
 *  slice in order inside this one run, each slice's PR based on the previous slice's PR head. */
export async function runIssueStack(
  issueNum: number,
  baseBranch: string | undefined,
  deps: IssueStackDeps,
): Promise<void> {
  const issues = await orderIssueChain(issueNum, deps.repo, deps.list);
  if (issues.length > 1) {
    const result = await runStack(
      issues.map((issue) => ({
        title: `issue #${issue}`,
        run: async (base: string | undefined) => {
          let outcome: RunOutcome | undefined;
          await deps.shipMember(issue, base, (value) => {
            outcome = value;
          });
          return outcome && { prNumber: 'prNumber' in outcome ? outcome.prNumber : undefined, branch: outcome.branch };
        },
      })),
      { base: baseBranch, chain: true, prefix: 'run-issue', noun: 'issue', log: consoleStackLog },
    );
    printStackResult(result, `Run failed for one or more issues in the stack (listed above)`);
    return;
  }
  await runSliceStack(
    { prefix: 'run-issue', label: `#${issueNum}`, failLabel: `issue #${issueNum}` },
    baseBranch,
    deps,
  );
}

/** The stack loop shared by `run-issue --stack` and `run-brief <file> --stack` (#3813); `subject` names the work in console text. */
export async function runSliceStack(
  subject: { prefix: string; label: string; failLabel: string },
  baseBranch: string | undefined,
  deps: SliceStackDeps,
): Promise<void> {
  let plan = await deps.readSlicePlan();
  if (plan === undefined) {
    console.log(styleText('cyan', `${subject.prefix}: --stack — sizing ${subject.label}`));
    let sizingError: unknown;
    try {
      await deps.ship(baseBranch, () => {});
    } catch (err) {
      sizingError = err;
    }
    plan = await deps.readSlicePlan();
    if (plan === undefined) {
      if (sizingError !== undefined) throw sizingError;
      return;
    }
  }
  const pending = plan.slices.filter((s) => s.state === 'pending');
  if (pending.length === 0) {
    console.log(styleText('cyan', `${subject.prefix}: every slice of ${subject.label} is already built`));
    return;
  }
  const count = plan.slices.length;
  const first = pending[0]!;
  let base = baseBranch;
  if (first.index > 1) {
    const below = plan.slices[first.index - 2]!;
    base = below.state === 'merged' ? baseBranch : below.branch;
  }
  console.log(
    styleText(
      'cyan',
      `${subject.prefix}: --stack — ${subject.label} has ${count} slices; building ${pending.length} in order, each on the previous slice's PR head`,
    ),
  );
  const result = await runStack(
    pending.map((s) => ({
      title: `slice ${s.index}/${count}`,
      run: async (sliceBase: string | undefined) => {
        let outcome: RunOutcome | undefined;
        await deps.ship(sliceBase, (o) => {
          outcome = o;
        });
        return outcome && { prNumber: 'prNumber' in outcome ? outcome.prNumber : undefined, branch: outcome.branch };
      },
    })),
    { base, chain: true, prefix: subject.prefix, noun: 'slice', log: consoleStackLog },
  );
  printStackResult(result, `Run failed for one or more slices of ${subject.failLabel} (listed above)`);
}
