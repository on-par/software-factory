import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FactoryEvent } from '../types/index.js';
import { followEvents, readEvents } from './index.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }) + line({ type: 'build', msg: 'Starting build phase' }));
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('plan');
    expect(events[1].type).toBe('build');
  });

  it('skips malformed lines', () => {
    writeFileSync(file, line({ type: 'plan', msg: 'ok' }) + 'not json\n' + line({ type: 'ship', msg: 'ok2' }));
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(['plan', 'ship']);
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
    const stop = followEvents(file, e => seen.push(e), { fromStart: true, pollMs: 10 });
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
    const stop = followEvents(file, e => seen.push(e), { fromStart: false, pollMs: 10 });
    stops.push(stop);

    appendFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await waitFor(() => seen.length >= 1);
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('build');
  });

  it('picks up a file created after following starts', async () => {
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, e => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await delay(30);
    writeFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    await waitFor(() => seen.length >= 1);
    expect(seen[0].type).toBe('plan');
  });

  it('delivers a partial line exactly once after it is completed', async () => {
    writeFileSync(file, '');
    const seen: FactoryEvent[] = [];
    const stop = followEvents(file, e => seen.push(e), { fromStart: true, pollMs: 10 });
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
    const stop = followEvents(file, e => seen.push(e), { fromStart: true, pollMs: 10 });
    stops.push(stop);

    await waitFor(() => seen.length >= 1);

    writeFileSync(file, ''); // truncate below the current offset
    await delay(30);
    writeFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await waitFor(() => seen.length >= 2);
    expect(seen[1].type).toBe('build');
  });

  it('stop() halts delivery and is idempotent', async () => {
    const seen: FactoryEvent[] = [];
    writeFileSync(file, '');
    const stop = followEvents(file, e => seen.push(e), { fromStart: true, pollMs: 10 });

    appendFileSync(file, line({ type: 'plan', msg: 'Starting plan phase' }));
    await waitFor(() => seen.length >= 1);

    stop();
    stop();
    appendFileSync(file, line({ type: 'build', msg: 'Starting build phase' }));
    await delay(50);
    expect(seen).toHaveLength(1);
  });
});
