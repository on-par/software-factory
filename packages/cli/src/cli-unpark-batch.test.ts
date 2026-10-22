import { readFileSync } from 'node:fs';

import { getFactoryPaths } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli/index.js';
import { unparkBatchJsonSchema } from './cli/json-contract.js';

const tmp = createTempDirs();
const PARKED = ['factory:parked', 'factory:lane:ops'];

let root: string;
let out: string[];
let err: string[];
let labels: Map<number, string[]>;
let bodies: Map<number, string>;
let issues: Record<string, ReturnType<typeof vi.fn>>;

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function setup(perIssue: Array<[number, string[]]>, issueBodies: Array<[number, string]> = []) {
  labels = new Map(perIssue);
  bodies = new Map(issueBodies);
  issues = {
    get: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
      data: { number: issue_number, body: bodies.get(issue_number) ?? '' },
    })),
    createLabel: vi.fn(async () => ({})),
    listForRepo: vi.fn(async () => ({ data: [] })),
    addLabels: vi.fn(async ({ issue_number, labels: add }: { issue_number: number; labels: string[] }) => {
      const cur = labels.get(issue_number) ?? [];
      labels.set(issue_number, [...cur, ...add.filter((l) => !cur.includes(l))]);
      return {};
    }),
    removeLabel: vi.fn(async ({ issue_number, name }: { issue_number: number; name: string }) => {
      labels.set(
        issue_number,
        (labels.get(issue_number) ?? []).filter((l) => l !== name),
      );
      return {};
    }),
    listLabelsOnIssue: vi.fn(async ({ issue_number }: { issue_number: number }) => ({
      data: (labels.get(issue_number) ?? []).map((name) => ({ name })),
    })),
  };
}

async function run(...args: string[]): Promise<number | undefined> {
  const octokit = { rest: { issues }, request: vi.fn(async () => ({ data: [] })) } as never;
  const cmd = (c: string) => (c.includes('rev-parse') ? root : c.includes('gh repo view') ? 'o/r' : '');
  try {
    await main(['node', 'factory', 'unpark', ...args], {
      exec: async (c: string) => ({ stdout: cmd(c), stderr: '' }),
      execSync: (c: string) => cmd(c),
      octokit: () => octokit,
    } as never);
  } catch (e) {
    if (e instanceof ExitError) return e.code;
    throw e;
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return code;
}

beforeEach(() => {
  root = tmp.makeSync('factory-unpark-batch-');
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    throw new ExitError(c ?? 0);
  }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

describe('factory unpark <issues...>', () => {
  it('a single issue (also given twice) prints one UnparkJson object and reads no issue body', async () => {
    setup([[12, PARKED]]);

    const code = await run('12', '12', '--json');

    expect(code).toBeUndefined();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ schemaVersion: 1, action: 'unpark', issue: 12, lane: 'ops' });
    expect(issues.get).not.toHaveBeenCalled();
  });

  it('refuses a prerequisite cycle, queues nothing, prints #10 -> #11 -> #10 and exits 1', async () => {
    setup(
      [
        [10, PARKED],
        [11, PARKED],
      ],
      [
        [10, 'Prerequisite: #11'],
        [11, 'Prerequisite: #10'],
      ],
    );

    const code = await run('10', '11');

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('#10 -> #11 -> #10');
    expect(issues.addLabels).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it('--json batch continues past a failed issue, prints one envelope with summary ok 2 failed 1 and exits 1', async () => {
    setup([
      [1, PARKED],
      [2, ['factory:lane:ops']],
      [3, PARKED],
    ]);

    const code = await run('1', '2', '3', '--json');

    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const envelope = unparkBatchJsonSchema.parse(JSON.parse(out[0]));
    expect(envelope.results).toHaveLength(3);
    expect(envelope.summary).toEqual({ ok: 2, failed: 1 });
    expect(labels.get(1)).toContain('factory:queued');
    expect(labels.get(3)).toContain('factory:queued');
    expect(labels.get(2)).not.toContain('factory:queued');
    const events = readFileSync(getFactoryPaths(root).events, 'utf-8');
    expect(events.match(/"type":"issue_unparked"/g)).toHaveLength(2);
  });

  it('exits 2 for an invalid issue among several', async () => {
    setup([[1, PARKED]]);

    const code = await run('1', 'abc');

    expect(code).toBe(2);
    expect(issues.addLabels).not.toHaveBeenCalled();
  });
});
