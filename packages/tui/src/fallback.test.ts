import type { FactoryEvent } from '@on-par/factory-core';
import { describe, expect, it, vi } from 'vitest';

import { followPlain } from './fallback.js';

function makeFakeFollow() {
  let onEvent: ((e: FactoryEvent) => void) | undefined;
  const stop = vi.fn();
  const follow = vi.fn((_file: string, cb: (e: FactoryEvent) => void) => {
    onEvent = cb;
    return stop;
  });
  return { follow, stop, push: (e: FactoryEvent) => onEvent?.(e) };
}

/** The whole stream surface followPlain touches: one write, plus the isTTY flag colorEnabled
 *  probes. A structural supertype of NodeJS.WritableStream, so one assertion widens it. */
interface FakeWritableStream {
  write(chunk: string): boolean;
  isTTY?: boolean;
}

function asWritableStream(fake: FakeWritableStream): NodeJS.WritableStream {
  return fake as NodeJS.WritableStream;
}

function makeFakeOut(isTTY = false): { out: NodeJS.WritableStream; chunks: string[] } {
  const chunks: string[] = [];
  return {
    out: asWritableStream({
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
      isTTY,
    }),
    chunks,
  };
}

describe('followPlain', () => {
  it('prints each event in the [factory] type #issue: msg format', () => {
    const fake = makeFakeFollow();
    const { out, chunks } = makeFakeOut();

    const stop = followPlain('events.ndjson', out, fake.follow);

    fake.push({ ts: '2026-01-01T00:00:00.000Z', type: 'plan', issue: '192', msg: 'Starting plan phase' });

    expect(chunks).toEqual(['[factory] plan #192: Starting plan phase\n']);
    expect(fake.follow).toHaveBeenCalledWith('events.ndjson', expect.any(Function), { fromStart: true });

    stop();
    expect(fake.stop).toHaveBeenCalled();
  });

  it('defaults to process.stdout and the real followEvents', () => {
    expect(() => {
      const stop = followPlain('/nonexistent/events.ndjson');
      stop();
    }).not.toThrow();
  });

  it('colors output when the injected stream reports a TTY', () => {
    const prevForceColor = process.env.FORCE_COLOR;
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    try {
      const fake = makeFakeFollow();
      const { out, chunks } = makeFakeOut(true);

      const stop = followPlain('events.ndjson', out, fake.follow);
      fake.push({ ts: '2026-01-01T00:00:00.000Z', type: 'plan', issue: '192', msg: 'Starting plan phase' });

      const chunk = chunks[0];
      expect(chunk).toContain('[');
      expect(chunk).toContain('Starting plan phase');

      stop();
    } finally {
      if (prevForceColor === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = prevForceColor;
      if (prevNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prevNoColor;
    }
  });
});
