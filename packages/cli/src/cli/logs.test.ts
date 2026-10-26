// packages/cli/src/cli/logs.test.ts

import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { readEvents } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { eventSegmentFileName, eventSegmentsDir } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLogsJson, cmdLogs, eventMatchesIssue, renderEvent, runLogs } from './logs.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await delay(stepMs);
  }
}

function line(e: Partial<FactoryEvent> & { type: string; msg: string; issue: string }): string {
  const full: FactoryEvent = { ts: new Date().toISOString(), ...e };
  return JSON.stringify(full) + '\n';
}

function outStub() {
  const written: string[] = [];
  return { written, out: { write: (s: string) => written.push(s), isTTY: false } };
}

describe('eventMatchesIssue', () => {
  it('matches when no issue filter is given', () => {
    expect(eventMatchesIssue({ ts: '', type: 'plan', issue: '296', msg: '' }, undefined)).toBe(true);
  });

  it('matches only the given issue', () => {
    const e: FactoryEvent = { ts: '', type: 'plan', issue: '296', msg: '' };
    expect(eventMatchesIssue(e, '296')).toBe(true);
    expect(eventMatchesIssue(e, '301')).toBe(false);
  });
});

describe('buildLogsJson', () => {
  it('keeps legacy event keys and omits cursor by default', () => {
    const event: FactoryEvent = { ts: 'now', type: 'plan', issue: '1', msg: 'hello' };
    expect(buildLogsJson(event)).toEqual(event);
  });

  it('adds a cursor and preserves interface payload fields', () => {
    const event: FactoryEvent = {
      ts: 'now',
      type: 'rework',
      issue: '1',
      msg: 'retry',
      rework: { round: 1, failingChecks: ['tests'], cause: 'factory-fault' },
    };
    expect(buildLogsJson(event, { cursor: 'c1.abc' })).toEqual({ ...event, cursor: 'c1.abc' });
  });
});

describe('renderEvent', () => {
  it('renders JSON.stringify output when json is requested', () => {
    const e: FactoryEvent = { ts: '2024-01-01T00:00:00.000Z', type: 'plan', issue: '1', msg: 'hello' };
    const rendered = renderEvent(e, { json: true, color: false });
    expect(JSON.parse(rendered)).toEqual(e);
  });

  it('renders the plain [factory] line when json is not requested', () => {
    const e: FactoryEvent = { ts: '', type: 'plan', issue: '1', msg: 'hello' };
    expect(renderEvent(e, { json: false, color: false })).toBe('[factory] plan #1: hello');
  });

  it('includes the lane token when lane is set', () => {
    const e: FactoryEvent = { ts: '', type: 'plan', issue: '1', msg: 'hello', lane: 'a' };
    expect(renderEvent(e, { json: false, color: false })).toBe('[factory] plan #1 [a]: hello');
  });
});

describe('runLogs (non-follow)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-logs-'));
    file = join(dir, 'events.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints existing events in the [factory] format and returns a no-op stop', () => {
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'Starting plan phase' }));
    const { written, out } = outStub();
    const stop = runLogs(file, {}, { out, env: {} });
    expect(written).toEqual(['[factory] plan #1: Starting plan phase\n']);
    expect(() => stop()).not.toThrow();
  });

  it('includes the [lane] token when lane is set', () => {
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'go', lane: 'x' }));
    const { written, out } = outStub();
    runLogs(file, {}, { out, env: {} });
    expect(written).toEqual(['[factory] plan #1 [x]: go\n']);
  });

  it('prints nothing and does not throw for a missing file', () => {
    const { written, out } = outStub();
    expect(() => runLogs(join(dir, 'missing.ndjson'), {}, { out, env: {} })).not.toThrow();
    expect(written).toEqual([]);
  });

  it('emits one JSON.parse-able object per line, round-tripping model/tokens/phase/lane', () => {
    writeFileSync(
      file,
      line({
        type: 'build',
        issue: '1',
        msg: 'done',
        model: 'claude-model',
        tokens: { input: 10, output: 20 },
        phase: 'build',
        lane: 'x',
      }),
    );
    const { written, out } = outStub();
    runLogs(file, { json: true }, { out, env: {} });
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]) as FactoryEvent;
    expect(parsed.model).toBe('claude-model');
    expect(parsed.tokens).toEqual({ input: 10, output: 20 });
    expect(parsed.phase).toBe('build');
    expect(parsed.lane).toBe('x');
  });

  it('filters by --issue', () => {
    writeFileSync(
      file,
      line({ ts: '', type: 'plan', issue: '296', msg: 'a' }) + line({ ts: '', type: 'plan', issue: '301', msg: 'b' }),
    );
    const { written, out } = outStub();
    runLogs(file, { issue: '296' }, { out, env: {} });
    expect(written).toEqual(['[factory] plan #296: a\n']);
  });
});

describe('runLogs (follow)', () => {
  let dir: string;
  let file: string;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-logs-follow-'));
    file = join(dir, 'events.ndjson');
  });

  afterEach(() => {
    while (stops.length) stops.pop()!();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tails a file created after following starts', async () => {
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });
    stops.push(stop);

    await delay(30);
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'hi' }));
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('[factory] plan #1: hi\n');
  });

  it('skips a malformed line and keeps tailing', async () => {
    writeFileSync(file, '');
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });
    stops.push(stop);

    appendFileSync(file, 'not json\n' + line({ ts: '', type: 'plan', issue: '1', msg: 'ok' }));
    await waitFor(() => written.length >= 1);
    expect(written).toEqual(['[factory] plan #1: ok\n']);
  });

  it('stop() halts delivery of subsequent appends', async () => {
    writeFileSync(file, '');
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });

    appendFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'first' }));
    await waitFor(() => written.length >= 1);

    stop();
    appendFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'second' }));
    await delay(50);
    expect(written).toEqual(['[factory] plan #1: first\n']);
  });

  it('stop() catches up on an event written in the poll window right before it is called', async () => {
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'first' }));
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });
    await waitFor(() => written.length >= 1);

    // Append and stop synchronously (no await between them) so no poll tick can
    // interleave — reproducing an event racing SIGINT within the poll window.
    appendFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'last-before-sigint' }));
    stop();

    expect(written).toEqual(['[factory] plan #1: first\n', '[factory] plan #1: last-before-sigint\n']);
  });
});

describe('cmdLogs', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-logs-cmd-'));
    file = join(dir, 'events.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('non-follow mode prints and returns without hanging', async () => {
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'hi' }));
    const { written, out } = outStub();
    await cmdLogs({}, { eventsFile: file, out, env: {} });
    expect(written).toEqual(['[factory] plan #1: hi\n']);
  });

  it('follow mode tails until SIGINT, then stops and resolves', async () => {
    writeFileSync(file, line({ ts: '', type: 'plan', issue: '1', msg: 'hi' }));
    const { written, out } = outStub();
    const done = cmdLogs({ follow: true }, { eventsFile: file, out, env: {}, pollMs: 10 });

    await waitFor(() => written.length >= 1);
    process.emit('SIGINT');
    await done;

    appendFileSync(file, line({ type: 'plan', issue: '1', msg: 'after-stop' }));
    await delay(30);
    expect(written).toEqual(['[factory] plan #1: hi\n']);
  });
});

const tmp = createTempDirs();

describe('runLogs --limit/--since', () => {
  let dir: string;
  let file: string;
  const total = 200_000;
  const evLine = (i: number) =>
    `{"ts":"2026-01-01T00:00:00.000Z","type":"plan","issue":"${i % 50}","msg":"event ${i}"}\n`;
  const parse = (written: string[]) => written.map((w) => JSON.parse(w) as FactoryEvent & { cursor: string });

  beforeEach(() => {
    dir = tmp.makeSync('factory-logs-tail-');
    file = join(dir, 'events.ndjson');
    writeFileSync(file, Array.from({ length: total }, (_, i) => evLine(i)).join(''));
  });

  afterEach(async () => {
    process.exitCode = undefined;
    await tmp.cleanup();
  });

  const run = (opts: Parameters<typeof runLogs>[1]) => {
    const { written, out } = outStub();
    runLogs(file, { json: true, ...opts }, { out, env: {} });
    return parse(written);
  };

  it('--limit 500 on a 200,000-event log prints the newest 500 oldest first and reads under 1 MB', () => {
    const { written, out } = outStub();
    let bytes = 0;
    runLogs(file, { json: true, limit: 500 }, { out, env: {}, onBytesRead: (n) => (bytes += n) });
    const events = parse(written);
    expect(events).toHaveLength(500);
    expect(events.map((e) => e.msg)).toEqual(Array.from({ length: 500 }, (_, i) => `event ${199_500 + i}`));
    expect(events.every((e) => typeof e.cursor === 'string')).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1_000_000);
  }, 30_000);

  it('--since the cursor of event 199,990 prints only the 10 later events, and the newest cursor prints nothing', () => {
    const tail = run({ limit: 11 });
    const after = run({ since: tail[0]!.cursor });
    expect(after.map((e) => e.msg)).toEqual(Array.from({ length: 10 }, (_, i) => `event ${199_990 + i}`));
    expect(run({ since: tail[10]!.cursor })).toEqual([]);
  }, 30_000);

  it('a cursor taken before rotation into state/logs/events/ returns exactly the 10 events appended after it', () => {
    const [mid, last] = [run({ limit: 5 })[0]!, run({ limit: 1 })[0]!];
    mkdirSync(eventSegmentsDir(file), { recursive: true });
    renameSync(file, join(eventSegmentsDir(file), eventSegmentFileName(0)));
    writeFileSync(file, Array.from({ length: 10 }, (_, i) => evLine(total + i)).join(''));
    expect(run({ since: last.cursor }).map((e) => e.msg)).toEqual(
      Array.from({ length: 10 }, (_, i) => `event ${total + i}`),
    );
    expect(run({ since: mid.cursor })).toHaveLength(4 + 10);
    expect(run({ limit: 12 }).map((e) => e.msg)[0]).toBe(`event ${total - 2}`);
  }, 30_000);

  it('combines --issue with --limit', () => {
    const events = run({ limit: 3, issue: '7' });
    expect(events.map((e) => e.msg)).toEqual(['event 199857', 'event 199907', 'event 199957']);
    expect(events.every((e) => e.issue === '7')).toBe(true);
  }, 30_000);

  it('--since with --limit pages forward', () => {
    const first = run({ limit: 3 });
    const page = run({ since: first[0]!.cursor, limit: 1 });
    expect(page.map((e) => e.msg)).toEqual(['event 199998']);
  }, 30_000);

  it('human format has no cursor', () => {
    const { written, out } = outStub();
    runLogs(file, { limit: 1 }, { out, env: {} });
    expect(written).toEqual(['[2026-01-01T00:00:00.000Z] [factory] plan #49: event 199999\n']);
  });

  it('--follow with --limit prints the page, then newly appended events', async () => {
    const { written, out } = outStub();
    const stop = runLogs(file, { json: true, limit: 2, follow: true }, { out, env: {}, pollMs: 10 });
    appendFileSync(file, evLine(total));
    await waitFor(() => written.length === 3);
    stop();
    expect(parse(written).map((e) => e.msg)).toEqual(['event 199998', 'event 199999', `event ${total}`]);
  }, 30_000);

  it('cmdLogs sets exit code 1 and writes a JSON error for bad cursors and limits', async () => {
    const errors: string[] = [];
    const deps = { eventsFile: file, out: outStub().out, env: {}, err: { write: (s: string) => errors.push(s) } };
    await cmdLogs({ json: true, since: 'garbage' }, deps);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(errors[0]!).error).toBe('malformed-cursor');

    const unknown = 'c1.' + Buffer.from(JSON.stringify({ v: 1, s: 12345, o: 0 })).toString('base64url');
    await cmdLogs({ json: true, since: unknown }, deps);
    expect(JSON.parse(errors[1]!).error).toBe('unknown-cursor');

    await cmdLogs({ json: true, limit: 0 }, deps);
    expect(JSON.parse(errors[2]!).error).toBe('invalid-limit');
  });

  it('without --limit or --since output equals the legacy readEvents rendering byte for byte', () => {
    writeFileSync(file, evLine(1) + evLine(2));
    for (const json of [true, false]) {
      const { written, out } = outStub();
      runLogs(file, json ? { json } : {}, { out, env: {} });
      expect(written).toEqual(readEvents(file).map((e) => renderEvent(e, { json, color: false }) + '\n'));
    }
  });
});

describe('runLogs (rotated segments, #3711)', () => {
  const tmp = createTempDirs();
  let file: string;
  const ev = (i: number) => line({ type: 'plan', issue: '1', msg: `event ${i}`, ts: '2026-01-01T00:00:00.000Z' });
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  beforeEach(() => {
    const dir = tmp.makeSync('factory-logs-rotated-');
    file = join(dir, 'events.ndjson');
    mkdirSync(eventSegmentsDir(file), { recursive: true });
    const seg0 = range(0, 4).map(ev).join('');
    writeFileSync(join(eventSegmentsDir(file), eventSegmentFileName(0)), seg0);
    writeFileSync(
      join(eventSegmentsDir(file), eventSegmentFileName(Buffer.byteLength(seg0))),
      range(4, 8).map(ev).join(''),
    );
    writeFileSync(file, range(8, 10).map(ev).join(''));
  });

  afterEach(() => tmp.cleanup());

  const msgs = (written: string[]) => written.map((l) => JSON.parse(l).msg);
  const expected = range(0, 10).map((i) => `event ${i}`);

  it('bare logs prints every event from 2 rotated segments and the live file, oldest first', () => {
    const { written, out } = outStub();
    runLogs(file, {}, { out, env: {} });
    expect(written).toHaveLength(10);
    written.forEach((l, i) => expect(l).toContain(`event ${i}`));
  });

  it('logs --json prints every event from 2 rotated segments and the live file, oldest first', () => {
    const { written, out } = outStub();
    runLogs(file, { json: true }, { out, env: {} });
    expect(msgs(written)).toEqual(expected);
  });

  it('bare --json and --json --limit 100 print the same events', () => {
    const bare = outStub();
    runLogs(file, { json: true }, { out: bare.out, env: {} });
    const limited = outStub();
    runLogs(file, { json: true, limit: 100 }, { out: limited.out, env: {} });
    expect(msgs(bare.written)).toEqual(msgs(limited.written));
  });

  it('--follow replays rotated segments before the live file and then tails new appends', async () => {
    const { written, out } = outStub();
    const stop = runLogs(file, { json: true, follow: true }, { out, env: {}, pollMs: 10 });
    await waitFor(() => written.length >= 10);
    expect(msgs(written.slice(0, 10))).toEqual(expected);
    appendFileSync(file, ev(10));
    await waitFor(() => written.length >= 11);
    stop();
    expect(msgs(written)).toEqual([...expected, 'event 10']);
  });
});
