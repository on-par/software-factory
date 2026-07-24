// packages/cli/src/cli/logs.test.ts

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FactoryEvent } from '@on-par/factory-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cmdLogs, eventMatchesIssue, renderEvent, runLogs } from './logs.js';

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
    writeFileSync(file, line({ type: 'plan', issue: '1', msg: 'Starting plan phase' }));
    const { written, out } = outStub();
    const stop = runLogs(file, {}, { out, env: {} });
    expect(written).toEqual(['[factory] plan #1: Starting plan phase\n']);
    expect(() => stop()).not.toThrow();
  });

  it('includes the [lane] token when lane is set', () => {
    writeFileSync(file, line({ type: 'plan', issue: '1', msg: 'go', lane: 'x' }));
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
      line({ type: 'plan', issue: '296', msg: 'a' }) + line({ type: 'plan', issue: '301', msg: 'b' }),
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
    writeFileSync(file, line({ type: 'plan', issue: '1', msg: 'hi' }));
    await waitFor(() => written.length >= 1);
    expect(written[0]).toBe('[factory] plan #1: hi\n');
  });

  it('skips a malformed line and keeps tailing', async () => {
    writeFileSync(file, '');
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });
    stops.push(stop);

    appendFileSync(file, 'not json\n' + line({ type: 'plan', issue: '1', msg: 'ok' }));
    await waitFor(() => written.length >= 1);
    expect(written).toEqual(['[factory] plan #1: ok\n']);
  });

  it('stop() halts delivery of subsequent appends', async () => {
    writeFileSync(file, '');
    const { written, out } = outStub();
    const stop = runLogs(file, { follow: true }, { out, env: {}, pollMs: 10 });

    appendFileSync(file, line({ type: 'plan', issue: '1', msg: 'first' }));
    await waitFor(() => written.length >= 1);

    stop();
    appendFileSync(file, line({ type: 'plan', issue: '1', msg: 'second' }));
    await delay(50);
    expect(written).toEqual(['[factory] plan #1: first\n']);
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
    writeFileSync(file, line({ type: 'plan', issue: '1', msg: 'hi' }));
    const { written, out } = outStub();
    await cmdLogs({}, { eventsFile: file, out, env: {} });
    expect(written).toEqual(['[factory] plan #1: hi\n']);
  });

  it('follow mode tails until SIGINT, then stops and resolves', async () => {
    writeFileSync(file, line({ type: 'plan', issue: '1', msg: 'hi' }));
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
