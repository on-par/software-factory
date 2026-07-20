import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { validateQueue } from '../queue/index.js';
import * as commandRunner from '../utils/command-runner.js';
import type { AutoIngestDeps } from './index.js';
import { issueFromFactoryBranch, runAutoIngest } from './index.js';

interface FakeIssue {
  number: number;
  title: string;
  updatedAt: string;
}

interface FakeRunOpts {
  issues?: FakeIssue[];
  issueListOk?: boolean;
  issueListStdout?: string;
  prHeadRefs?: string[];
  prListOk?: boolean;
}

function fakeRun(opts: FakeRunOpts) {
  const calls: (readonly string[])[] = [];
  const run = async (argv: readonly string[], _cwdOpts?: { cwd: string }) => {
    calls.push(argv);
    if (argv[1] === 'issue' && argv[2] === 'list') {
      if (opts.issueListOk === false) return { stdout: opts.issueListStdout ?? 'boom', ok: false };
      if (opts.issueListStdout !== undefined) return { stdout: opts.issueListStdout, ok: true };
      return { stdout: JSON.stringify(opts.issues ?? []), ok: true };
    }
    if (argv[1] === 'pr' && argv[2] === 'list') {
      if (opts.prListOk === false) return { stdout: 'boom', ok: false };
      return {
        stdout: JSON.stringify((opts.prHeadRefs ?? []).map((headRefName) => ({ headRefName }))),
        ok: true,
      };
    }
    throw new Error(`unexpected argv: ${argv.join(' ')}`);
  };
  return { run, calls };
}

function makeDeps(opts: {
  runOpts: FakeRunOpts;
  queueContent?: string | null;
  watermarkContent?: string | null;
  now?: Date;
}): { deps: AutoIngestDeps; writes: Record<string, string>; run: ReturnType<typeof fakeRun>['run'] } {
  const { run } = fakeRun(opts.runOpts);
  const writes: Record<string, string> = {};
  const files: Record<string, string | null> = {
    '/repo/.factory/queue': opts.queueContent ?? null,
    '/repo/.factory/ingest-watermark': opts.watermarkContent ?? null,
  };
  const deps: AutoIngestDeps = {
    now: () => opts.now ?? new Date('2026-07-20T00:00:00.000Z'),
    run,
    readFile: (path: string) => files[path] ?? null,
    writeFile: (path: string, content: string) => {
      writes[path] = content;
    },
  };
  return { deps, writes, run };
}

const QUEUE_FILE = '/repo/.factory/queue';
const WATERMARK_FILE = '/repo/.factory/ingest-watermark';

describe('issueFromFactoryBranch', () => {
  it('parses a factory branch into an issue number', () => {
    expect(issueFromFactoryBranch('ship-it/388-foo', 'ship-it')).toBe(388);
  });

  it('returns null for a non-factory branch', () => {
    expect(issueFromFactoryBranch('main', 'ship-it')).toBeNull();
    expect(issueFromFactoryBranch('feature/foo', 'ship-it')).toBeNull();
  });

  it('respects a custom branch prefix', () => {
    expect(issueFromFactoryBranch('custom/42-bar', 'custom')).toBe(42);
    expect(issueFromFactoryBranch('ship-it/42-bar', 'custom')).toBeNull();
  });
});

describe('runAutoIngest', () => {
  it('appends a new ready issue not in the queue or in flight', async () => {
    const { deps, writes } = makeDeps({
      runOpts: { issues: [{ number: 100, title: 'Do the thing', updatedAt: '2026-07-19T00:00:00.000Z' }] },
      queueContent: '',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([100]);
    expect(result.candidates).toBe(1);
    expect(writes[QUEUE_FILE]).toBe('auto 100\n');
    expect(writes[WATERMARK_FILE]).toBe('2026-07-19T00:00:00.000Z\n');
    expect(result.watermark).toBe('2026-07-19T00:00:00.000Z');
  });

  it('skips an issue already present in the queue file', async () => {
    const { deps, writes } = makeDeps({
      runOpts: { issues: [{ number: 100, title: 'Already queued', updatedAt: '2026-07-19T00:00:00.000Z' }] },
      queueContent: 'auto 100\n',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([]);
    expect(result.skippedInQueue).toEqual([100]);
    expect(writes[QUEUE_FILE]).toBeUndefined();
  });

  it('skips an issue with an open ship-it/<n>-... PR', async () => {
    const { deps } = makeDeps({
      runOpts: {
        issues: [{ number: 200, title: 'In flight', updatedAt: '2026-07-19T00:00:00.000Z' }],
        prHeadRefs: ['ship-it/200-in-flight'],
      },
      queueContent: '',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([]);
    expect(result.skippedInFlight).toEqual([200]);
  });

  it('skips a stale issue (updatedAt <= prevWatermark) and advances the watermark to the max updatedAt seen', async () => {
    const { deps, writes } = makeDeps({
      runOpts: {
        issues: [
          { number: 1, title: 'Stale', updatedAt: '2026-07-18T00:00:00.000Z' },
          { number: 2, title: 'Fresh', updatedAt: '2026-07-19T12:00:00.000Z' },
        ],
      },
      queueContent: '',
      watermarkContent: '2026-07-18T00:00:00.000Z',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.skippedStale).toEqual([1]);
    expect(result.appended).toEqual([2]);
    expect(result.watermark).toBe('2026-07-19T12:00:00.000Z');
    expect(writes[WATERMARK_FILE]).toBe('2026-07-19T12:00:00.000Z\n');
  });

  it('never regresses the watermark below the previous value', async () => {
    const { deps } = makeDeps({
      runOpts: {
        issues: [{ number: 1, title: 'Older than watermark', updatedAt: '2026-07-01T00:00:00.000Z' }],
      },
      queueContent: '',
      watermarkContent: '2026-07-19T00:00:00.000Z',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.watermark).toBe('2026-07-19T00:00:00.000Z');
    expect(result.skippedStale).toEqual([1]);
  });

  it('works with a missing queue file and missing watermark file', async () => {
    const { deps, writes } = makeDeps({
      runOpts: { issues: [{ number: 5, title: 'First ever', updatedAt: '2026-07-19T00:00:00.000Z' }] },
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([5]);
    expect(writes[QUEUE_FILE]).toBe('auto 5\n');
    expect(writes[WATERMARK_FILE]).toBe('2026-07-19T00:00:00.000Z\n');
  });

  it('seeds the watermark from now() when the ready-issue list is empty and no watermark exists', async () => {
    const now = new Date('2026-07-20T00:00:00.000Z');
    const { deps, writes } = makeDeps({ runOpts: { issues: [] }, now });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([]);
    expect(result.watermark).toBe('2026-07-20T00:00:00.000Z');
    expect(writes[WATERMARK_FILE]).toBe('2026-07-20T00:00:00.000Z\n');
  });

  it('does not append and does not regress the watermark when gh issue list fails', async () => {
    const { deps, writes } = makeDeps({
      runOpts: { issueListOk: false },
      queueContent: '',
      watermarkContent: '2026-07-18T00:00:00.000Z',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([]);
    expect(result.watermark).toBe('2026-07-18T00:00:00.000Z');
    expect(writes[WATERMARK_FILE]).toBeUndefined();
    expect(writes[QUEUE_FILE]).toBeUndefined();
  });

  it('does not append and does not throw when gh issue list returns unparseable stdout', async () => {
    const { deps } = makeDeps({
      runOpts: { issueListStdout: 'not json' },
      queueContent: '',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([]);
  });

  it('still appends when gh pr list fails (best-effort in-flight dedup)', async () => {
    const { deps } = makeDeps({
      runOpts: {
        issues: [{ number: 300, title: 'Still appends', updatedAt: '2026-07-19T00:00:00.000Z' }],
        prListOk: false,
      },
      queueContent: '',
    });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE },
      deps,
    );

    expect(result.appended).toEqual([300]);
    expect(result.skippedInFlight).toEqual([]);
  });

  it('appends a trailing newline before new entries when the existing queue lacks one, keeping the queue valid', async () => {
    const { deps, writes } = makeDeps({
      runOpts: { issues: [{ number: 400, title: 'No trailing newline', updatedAt: '2026-07-19T00:00:00.000Z' }] },
      queueContent: 'manual 1',
    });

    await runAutoIngest({ repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE }, deps);

    const newContent = writes[QUEUE_FILE];
    expect(newContent).toBe('manual 1\nauto 400\n');
    expect(validateQueue(newContent).ok).toBe(true);
  });

  it('caps the number of appended issues to maxPerCycle', async () => {
    const issues: FakeIssue[] = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      updatedAt: '2026-07-19T00:00:00.000Z',
    }));
    const { deps, writes } = makeDeps({ runOpts: { issues }, queueContent: '' });

    const result = await runAutoIngest(
      { repoDir: '/repo', queueFile: QUEUE_FILE, watermarkFile: WATERMARK_FILE, maxPerCycle: 2 },
      deps,
    );

    expect(result.appended).toEqual([1, 2]);
    expect(writes[QUEUE_FILE]).toBe('auto 1\nauto 2\n');
  });

  it('honors a custom label (passed to gh issue list) and lane (written into the queue line)', async () => {
    const { deps, writes, run } = makeDeps({
      runOpts: { issues: [{ number: 9, title: 'Custom', updatedAt: '2026-07-19T00:00:00.000Z' }] },
      queueContent: '',
    });
    const calls: (readonly string[])[] = [];
    const spiedRun: AutoIngestDeps['run'] = async (argv, opts) => {
      calls.push(argv);
      return run(argv, opts);
    };

    const result = await runAutoIngest(
      {
        repoDir: '/repo',
        queueFile: QUEUE_FILE,
        watermarkFile: WATERMARK_FILE,
        label: 'triaged',
        lane: 'nightly',
      },
      { ...deps, run: spiedRun },
    );

    expect(result.appended).toEqual([9]);
    expect(writes[QUEUE_FILE]).toBe('nightly 9\n');
    expect(calls.some((argv) => argv.includes('--label') && argv.includes('triaged'))).toBe(true);
  });

  it('falls back to production defaults (real fs readFile/writeFile, real now, runCommand) when deps are omitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ingest-'));
    const queueFile = join(dir, 'queue');
    const watermarkFile = join(dir, 'ingest-watermark');
    writeFileSync(queueFile, 'manual 1\n');
    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (argv) => {
      const stdout =
        argv[1] === 'issue' && argv[2] === 'list'
          ? JSON.stringify([{ number: 7, title: 'Real defaults', updatedAt: '2026-07-19T00:00:00.000Z' }])
          : JSON.stringify([]);
      return { command: argv, stdout, stderr: '', exitCode: 0, killed: false, timedOut: false, ok: true };
    });

    try {
      const result = await runAutoIngest({ repoDir: dir, queueFile, watermarkFile });

      expect(result.appended).toEqual([7]);
      expect(readFileSync(queueFile, 'utf-8')).toBe('manual 1\nauto 7\n');
      expect(readFileSync(watermarkFile, 'utf-8')).toBe('2026-07-19T00:00:00.000Z\n');
      expect(new Date(result.scannedAt).getTime()).not.toBeNaN();
      expect(runCommandSpy).toHaveBeenCalled();
    } finally {
      runCommandSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('production defaultReadFile returns null for a missing file (no queue/watermark on disk yet)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-ingest-'));
    const queueFile = join(dir, 'queue');
    const watermarkFile = join(dir, 'ingest-watermark');
    const runCommandSpy = vi.spyOn(commandRunner, 'runCommand').mockResolvedValue({
      command: [],
      stdout: '[]',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false,
      ok: true,
    });

    try {
      const result = await runAutoIngest({ repoDir: dir, queueFile, watermarkFile });

      expect(result.appended).toEqual([]);
    } finally {
      runCommandSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
