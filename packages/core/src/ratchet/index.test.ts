// packages/core/src/ratchet/index.test.ts — daily ratchet trigger (#3542)

import { describe, expect, it } from 'vitest';

import type { EventKind } from '../events/kinds.js';
import { DEFAULT_FILING_POLICY, isAutoMergeBlocked } from '../filing/policy.js';
import {
  parseExceptionList,
  RATCHET_LABEL,
  ratchetMarker,
  renderRatchetIssueBody,
  runRatchetTrigger,
  type RatchetGitHub,
  type RatchetListConfig,
} from './index.js';

const listA: RatchetListConfig = { name: 'max-lines', file: 'a.txt', check: 'npm run lint' };
const listB: RatchetListConfig = { name: 'types', file: 'b.txt', check: 'npm run typecheck' };

function harness(
  opts: { open?: Record<string, number[]>; files?: Record<string, string | null>; failFile?: boolean } = {},
) {
  const logs: { type: EventKind; subject: string; message: string }[] = [];
  const filed: { title: string; body: string; labels: string[] }[] = [];
  const enqueued: { lane: string; issue: number }[] = [];
  const github: RatchetGitHub = {
    openRatchetIssues: async (name) => opts.open?.[name] ?? [],
    fileIssue: async (input) => {
      if (opts.failFile) throw new Error('boom');
      filed.push(input);
      return 100 + filed.length;
    },
    enqueue: async (lane, issue) => {
      enqueued.push({ lane, issue });
      return { ok: true };
    },
  };
  const run = (lists: RatchetListConfig[]) =>
    runRatchetTrigger({
      lists,
      lane: 'auto',
      gateLabel: 'no-auto-merge',
      readList: (file) => (opts.files && file in opts.files ? opts.files[file] : null),
      github,
      log: (type, subject, message) => logs.push({ type, subject, message }),
    });
  return { run, logs, filed, enqueued };
}

describe('parseExceptionList', () => {
  it('trims lines and drops blanks and comments', () => {
    expect(parseExceptionList('  a.ts \n\n# note\n  # indented\nb.ts\n')).toEqual(['a.ts', 'b.ts']);
  });
});

describe('renderRatchetIssueBody', () => {
  it('carries the marker, entry, file and check', () => {
    const body = renderRatchetIssueBody(listA, 'src/x.ts');
    expect(body).toContain(ratchetMarker('max-lines'));
    expect(body).toContain('src/x.ts');
    expect(body).toContain('a.txt');
    expect(body).toContain('npm run lint');
    expect(body).toContain('human review');
  });
});

describe('runRatchetTrigger', () => {
  it('files and enqueues exactly one issue for the first entry of a 3-entry list', async () => {
    const h = harness({ files: { 'a.txt': 'one.ts\ntwo.ts\nthree.ts\n' } });
    const res = await h.run([listA]);
    expect(res.filed).toEqual({ list: 'max-lines', entry: 'one.ts', issue: 101 });
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0].title).toBe('ratchet(max-lines): remove one.ts');
    expect(h.filed[0].body).toContain(ratchetMarker('max-lines'));
    expect(h.enqueued).toEqual([{ lane: 'auto', issue: 101 }]);
    expect(h.logs.filter((l) => l.type === 'ratchet-filed')).toHaveLength(1);
  });

  it('files nothing for a list that has an open ratchet issue', async () => {
    const h = harness({ open: { 'max-lines': [7] }, files: { 'a.txt': 'one.ts\n' } });
    const res = await h.run([listA]);
    expect(h.filed).toHaveLength(0);
    expect(res.skipped).toEqual([{ list: 'max-lines', issues: [7] }]);
    expect(h.logs.some((l) => l.type === 'ratchet-skipped')).toBe(true);
  });

  it('emits one ratchet-done event naming an empty list and files nothing', async () => {
    const h = harness({ files: { 'a.txt': '# only a comment\n\n' } });
    const res = await h.run([listA]);
    expect(res.done).toEqual(['max-lines']);
    const done = h.logs.filter((l) => l.type === 'ratchet-done');
    expect(done).toHaveLength(1);
    expect(done[0].message).toContain('max-lines');
    expect(h.filed).toHaveLength(0);
  });

  it('never writes the list, and a parked open ratchet issue blocks a new run', async () => {
    const reads: string[] = [];
    const h = harness({ open: { 'max-lines': [9] } });
    const res = await runRatchetTrigger({
      lists: [listA],
      lane: 'auto',
      gateLabel: 'no-auto-merge',
      readList: (file) => {
        reads.push(file);
        return 'one.ts\n';
      },
      github: {
        openRatchetIssues: async () => [9],
        fileIssue: async () => {
          throw new Error('must not file');
        },
        enqueue: async () => ({ ok: true }),
      },
      log: () => {},
    });
    expect(reads).toEqual(['a.txt']);
    expect(res.filed).toBeUndefined();
    expect(res.errors).toEqual([]);
    expect(h.filed).toHaveLength(0);
  });

  it('labels the filed issue with the auto-merge gate label so isAutoMergeBlocked is true', async () => {
    const h = harness({ files: { 'a.txt': 'one.ts\n' } });
    await h.run([listA]);
    expect(h.filed[0].labels).toEqual([RATCHET_LABEL, 'no-auto-merge']);
    expect(isAutoMergeBlocked(h.filed[0].labels, DEFAULT_FILING_POLICY)).toBe(true);
  });

  it('files only one issue per firing across two lists', async () => {
    const h = harness({ files: { 'a.txt': 'one.ts\n', 'b.txt': 'two.ts\n' } });
    await h.run([listA, listB]);
    expect(h.filed).toHaveLength(1);
  });

  it('moves on to the second list when the first is blocked', async () => {
    const h = harness({ open: { 'max-lines': [3] }, files: { 'a.txt': 'one.ts\n', 'b.txt': 'two.ts\n' } });
    const res = await h.run([listA, listB]);
    expect(res.filed?.list).toBe('types');
  });

  it('warns on a missing file and gives no ratchet-done', async () => {
    const h = harness({ files: {} });
    const res = await h.run([listA]);
    expect(res.errors).toHaveLength(1);
    expect(h.logs.map((l) => l.type)).toEqual(['warn']);
    expect(h.logs[0].message).toContain('a.txt');
  });

  it('records a fileIssue throw in errors without throwing', async () => {
    const h = harness({ files: { 'a.txt': 'one.ts\n' }, failFile: true });
    const res = await h.run([listA]);
    expect(res.errors).toHaveLength(1);
    expect(res.filed).toBeUndefined();
  });

  it('records a failed open-issue lookup in errors', async () => {
    const res = await runRatchetTrigger({
      lists: [listA],
      lane: 'auto',
      gateLabel: 'no-auto-merge',
      readList: () => 'one.ts\n',
      github: {
        openRatchetIssues: async () => {
          throw new Error('rate limited');
        },
        fileIssue: async () => 1,
        enqueue: async () => ({ ok: true }),
      },
      log: () => {},
    });
    expect(res.errors[0]).toContain('rate limited');
  });

  it('warns when enqueue is not ok but still reports the filed issue', async () => {
    const logs: EventKind[] = [];
    const res = await runRatchetTrigger({
      lists: [listA],
      lane: 'auto',
      gateLabel: 'no-auto-merge',
      readList: () => 'one.ts\n',
      github: {
        openRatchetIssues: async () => [],
        fileIssue: async () => 5,
        enqueue: async () => ({ ok: false, detail: 'nope' }),
      },
      log: (type) => logs.push(type),
    });
    expect(res.filed?.issue).toBe(5);
    expect(logs).toContain('warn');
  });
});
