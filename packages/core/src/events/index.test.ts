import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FactoryEvent } from '../types/index.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { createLogger } from '../logger/index.js';
import { eventSegmentFileName, eventSegmentsDir } from './tail.js';
import { followEvents, readEvents } from './index.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out');
    }
    await delay(stepMs);
  }
}

function line(e: Partial<FactoryEvent> & { type: string; msg: string }): string {
  const full: FactoryEvent = { ts: new Date().toISOString(), issue: '1', ...e };
  return JSON.stringify(full) + '\n';
}

describe('readEvents', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-events-'));
    file = join(dir, 'events.ndjson');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the file does not exist', () => {
    expect(readEvents(file)).toEqual([]);
  });

  it('parses valid NDJSON lines', () => {
    writeFileSync(
      file,
      line({ type: 'plan', msg: 'Starting plan phase' }) + line({ type: 'build', msg: 'Starting build phase' }),
    );
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('plan');
    expect(events[1].type).toBe('build');
  });

  it('parses a legacy line without attribution as undefined', () => {
    writeFileSync(file, line({ type: 'fail', msg: 'old' }));
    expect(readEvents(file)[0].attribution).toBeUndefined();
  });

  it('round-trips attribution', () => {
    const attribution = { plan: { model: 'm', provider: 'p' }, endedIn: 'check' as const };
    writeFileSync(file, line({ type: 'fail', msg: 'new', attribution }));
    expect(readEvents(file)[0].attribution).toEqual(attribution);
  });

  it('skips malformed lines', () => {
    writeFileSync(file, line({ type: 'plan', msg: 'ok' }) + 'not json\n' + line({ type: 'ship', msg: 'ok2' }));
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.type)).toEqual(['plan', 'ship']);
  });
});

describe('followEvents', () => {
  let dir: string;
  let file: string;
  const stops: Array<() => void> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-events-follow-'));
    file = join(dir, 'events.ndjson');
  });

  afterEach(() => {
    while (stops.length) stops.pop()!();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replays existing events when fromStart is true, then delivers appended ones', async () => {
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await waitFor(() => seen.length >= 1);
    expect(seen[0].type).toBe('plan');

    appendFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await waitFor(() => seen.length >= 2);
    expect(seen[1].type).toBe('build');
  });

  it('skips history when fromStart is false', async () => {
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: false, pollMs: 10 });
    stops.push(stop);

    appendFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await waitFor(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('build');
  });

  it('picks up a file created after following starts', async () => {
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await delay(30);
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    await waitFor(() => seen.length >= 1);
    expect(seen[0].type).toBe('plan');
  });

  it('delivers a partial line exactly once after it is completed', async () => {
    writeFileSync(file, '');
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    const full = line({ type: 'plan', msg: 'Starting plan phase' });
    const partial = full.slice(0, -1); // no trailing newline
    appendFileSync(file, partial);
    await delay(50);
    expect(seen).toHaveLength(0);

    appendFileSync(file, '\n');
    await waitFor(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('plan');
  });

  it('resets and re-reads after truncation', async () => {
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await waitFor(() => seen.length >= 1);

    writeFileSync(file, ''); // truncate below the current offset
    await delay(30);
    writeFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await waitFor(() => seen.length >= 2);
    expect(seen[1].type).toBe('build');
  });

  it('detects a log-rotation-style replace even when the new file is already as large as the old offset', async () => {
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await waitFor(() => seen.length >= 1);

    // Atomically replace the file (as log rotation does: write to a fresh
    // path, then rename over the target) with content that is already >= the
    // old offset in size, so a size-only truncation check would miss the
    // swap and concatenate stale bytes from the old inode's tail read.
    const replacement = join(dir, 'events-rotated.ndjson');
    writeFileSync(replacement, line({ type: 'build', msg: 'Starting build phase, replacing the old log entirely' }));
    renameSync(replacement, file);

    await waitFor(() => seen.length >= 2);
    expect(seen[1].type).toBe('build');
    expect(seen[1].msg).toBe('Starting build phase, replacing the old log entirely');
  });

  it('reads a file rotated between stat and open from its start, not at the old offset', async () => {
    // Pad a line to an exact byte length so the rotated file's line boundaries
    // land on the old file's offsets.
    const lineOfLength = (type: FactoryEvent['type'], msg: string, length: number): string => {
      const base = line({ type, msg });
      return line({ type, msg: msg + 'x'.repeat(length - base.length) });
    };
    const first = line({ type: 'plan', msg: 'first, padded so the rotated head fits inside it' });
    const oldTail = line({ type: 'ship', msg: 'old tail, padded so the rotated head fits before it' });
    writeFileSync(file, first);
    let beforeOpen: (() => void) | undefined;
    const openFile = (path: string): number => {
      const hook = beforeOpen;
      beforeOpen = undefined;
      hook?.();
      return openSync(path, 'r');
    };
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10, openFile });
    stops.push(stop);
    await waitFor(() => seen.length >= 1);

    // The old file grows, so the next tick has something to read. Just before
    // that read opens the path, rotation swaps in a new file whose second line
    // starts exactly at the old offset. Reading the new file at the old offset
    // would deliver that line on its own, then again after the inode reset.
    const replacement = join(dir, 'events-rotated.ndjson');
    writeFileSync(replacement, lineOfLength('build', 'r1', first.length) + lineOfLength('check', 'r2', oldTail.length));
    beforeOpen = () => renameSync(replacement, file);
    appendFileSync(file, oldTail);

    await waitFor(() => seen.length >= 3);
    await delay(50);
    expect(seen.map((e) => e.type)).toEqual(['plan', 'build', 'check']);
  });

  it('stop() halts delivery and is idempotent', async () => {
    const seen: FactoryEvent[] = [];
    writeFileSync(file, '');
    const stop = followEvents(file, (e) => seen.push(e), { fromStart: true, pollMs: 10 });

    appendFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    await waitFor(() => seen.length >= 1);

    stop();
    stop();
    appendFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await delay(50);
    expect(seen).toHaveLength(1);
  });

  it('startOffset delivers only events appended after that offset', async () => {
    writeFileSync(file, line({ type: 'plan', msg: 'old' }));
    const size = readFileSync(file).length;
    const seen: FactoryEvent[] = [];
    stops.push(followEvents(file, (e) => seen.push(e), { startOffset: size, pollMs: 10 }));
    appendFileSync(file, line({ type: 'build', msg: 'new' }));
    await waitFor(() => seen.length === 1);
    expect(seen.map((e) => e.msg)).toEqual(['new']);
  });
});

const segTmp = createTempDirs();

describe('readEvents with includeSegments (#1631)', () => {
  afterEach(() => segTmp.cleanup());

  it('returns segments oldest first then the live file; default is live only', () => {
    const dir = segTmp.makeSync('factory-events-seg-');
    {
      const file = join(dir, 'events.ndjson');
      const segDir = eventSegmentsDir(file);
      mkdirSync(segDir, { recursive: true });
      const a = line({ type: 'plan', msg: 'a' });
      writeFileSync(join(segDir, eventSegmentFileName(0)), a);
      writeFileSync(join(segDir, eventSegmentFileName(Buffer.byteLength(a))), line({ type: 'plan', msg: 'b' }));
      writeFileSync(file, line({ type: 'plan', msg: 'c' }));
      expect(readEvents(file, { includeSegments: true }).map((e) => e.msg)).toEqual(['a', 'b', 'c']);
      expect(readEvents(file).map((e) => e.msg)).toEqual(['c']);
      rmSync(file);
      expect(readEvents(file, { includeSegments: true }).map((e) => e.msg)).toEqual(['a', 'b']);
    }
  });
});

describe('followEvents across rotation (#1631)', () => {
  afterEach(() => segTmp.cleanup());

  it('emits every event exactly once across a logger rotation, including lines written to the old file after the last poll', async () => {
    const dir = segTmp.makeSync('factory-events-rot-');
    const file = join(dir, 'events.ndjson');
    const log = createLogger(file, {}, { out: { write: () => true }, env: {}, rotation: { maxBytes: 600 } });
    const seen: string[] = [];
    const stop = followEvents(file, (e) => seen.push(e.msg), { pollMs: 10 });
    try {
      const written: string[] = [];
      for (let burst = 0; burst < 4; burst++) {
        // Several writes between polls so a rotation lands with unread lines in the old file.
        for (let i = 0; i < 5; i++) {
          const msg = `m${burst}-${i}`;
          written.push(msg);
          log.info('plan', msg);
        }
        await delay(25);
      }
      await waitFor(() => seen.length >= written.length);
      await delay(40);
      expect(seen).toEqual(written);
      expect(readdirSync(eventSegmentsDir(file)).length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
