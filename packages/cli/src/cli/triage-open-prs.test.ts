import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { proposeTriageQueue, skippedIssuesComment } from './triage-open-prs.js';

const output = 'app 1\napp 3\napp 5\n';
const prs = (...nums: number[]) => JSON.stringify(nums.map((n) => ({ headRefName: `factory/${n}-x` })));

describe('proposeTriageQueue (#2981)', () => {
  let dir: string;
  let events: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-open-prs-'));
    events = join(dir, 'events.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const logged = () => {
    try {
      return readFileSync(events, 'utf-8');
    } catch {
      return '';
    }
  };

  it('drops issues with an open factory branch PR and keeps the rest', async () => {
    const cmds: string[] = [];
    const exec = async (cmd: string) => {
      cmds.push(cmd);
      return { stdout: prs(1, 3) };
    };
    expect(await proposeTriageQueue(output, 'o/r', events, exec)).toBe('# Skipped (a PR is open): #1, #3\napp 5\n');
    expect(cmds[0]).toContain('gh pr list');
    expect(cmds[0]).toContain('--state open');
    expect(logged()).toContain('Dropped issue(s) with an open factory PR: #1, #3');
  });

  it('writes no skipped comment line when nothing is dropped (#2982)', async () => {
    const res = await proposeTriageQueue(output, 'o/r', events, async () => ({ stdout: prs(7) }));
    expect(res).toBe(output);
    expect(res).not.toContain('Skipped');
  });

  it('formats the skipped comment line (#2982)', () => {
    expect(skippedIssuesComment([])).toBe('');
    expect(skippedIssuesComment([1, 3])).toBe('# Skipped (a PR is open): #1, #3\n');
  });

  it('keeps the queue unfiltered when gh pr list fails', async () => {
    const exec = async (): Promise<{ stdout: string }> => {
      throw new Error('boom');
    };
    expect(await proposeTriageQueue(output, 'o/r', events, exec)).toBe(output);
    expect(logged()).toContain('could not list open PRs');
    expect(logged()).toContain('boom');
  });

  it('warns and keeps the queue unfiltered when gh output is malformed', async () => {
    expect(await proposeTriageQueue(output, 'o/r', events, async () => ({ stdout: 'not json' }))).toBe(output);
    expect(logged()).toContain('could not list open PRs');
  });

  it('treats empty gh output as no open PRs and stringifies non-Error failures', async () => {
    expect(await proposeTriageQueue(output, 'o/r', events, async () => ({ stdout: '' }))).toBe(output);
    expect(await proposeTriageQueue(output, 'o/r', events, () => Promise.reject('nope'))).toBe(output);
    expect(logged()).toContain('nope');
  });

  it('returns an empty string when every entry has an open PR or the model gave nothing', async () => {
    expect(await proposeTriageQueue(output, 'o/r', events, async () => ({ stdout: prs(1, 3, 5) }))).toBe('');
    expect(await proposeTriageQueue('prose only', 'o/r', events, async () => ({ stdout: prs(1) }))).toBe('');
  });
});

describe('proposeTriageQueue closing keywords (#2983)', () => {
  let dir: string;
  let events: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'triage-open-prs-kw-'));
    events = join(dir, 'events.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('drops an issue closed by keyword in an open PR on a non-factory branch (#2983)', async () => {
    const cmds: string[] = [];
    const exec = async (cmd: string) => {
      cmds.push(cmd);
      return { stdout: JSON.stringify([{ headRefName: 'feature/x', title: 't', body: 'Closes #7', state: 'OPEN' }]) };
    };
    expect(await proposeTriageQueue('app 5\napp 7\n', 'o/r', events, exec)).toBe(
      '# Skipped (a PR is open): #7\napp 5\n',
    );
    expect(cmds[0]).toContain('--json headRefName,title,body,state');
  });

  it('keeps an issue whose closing-keyword PR is closed (#2983)', async () => {
    const exec = async (cmd: string) => ({
      stdout: cmd.includes('--state open')
        ? JSON.stringify([{ headRefName: 'other', body: 'Closes #8', state: 'CLOSED' }])
        : JSON.stringify([{ headRefName: 'other', body: 'Closes #8', state: 'MERGED' }]),
    });
    const res = await proposeTriageQueue('app 5\napp 8\n', 'o/r', events, exec);
    expect(res).toBe('app 5\napp 8\n');
    expect(res).not.toContain('Skipped');
  });
});
