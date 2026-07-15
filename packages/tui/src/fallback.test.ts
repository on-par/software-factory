import { describe, expect, it, vi } from 'vitest';
import type { FactoryEvent } from '@on-par/factory-core';
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

function makeFakeOut() {
  const chunks: string[] = [];
  return { write: (chunk: string) => { chunks.push(chunk); return true; }, chunks } as unknown as NodeJS.WritableStream & { chunks: string[] };
}

describe('followPlain', () => {
  it('prints each event in the [factory] type #issue: msg format', () => {
    const fake = makeFakeFollow();
    const out = makeFakeOut();

    const stop = followPlain('events.ndjson', out, fake.follow);

    fake.push({ ts: '2026-01-01T00:00:00.000Z', type: 'plan', issue: '192', msg: 'Starting plan phase' });

    expect((out as any).chunks).toEqual(['[factory] plan #192: Starting plan phase\n']);
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
});
