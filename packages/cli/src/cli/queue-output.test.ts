// packages/cli/src/cli/queue-output.test.ts — queue add / unpark text rendering incl. order collisions (#2988).

import { stripVTControlCharacters } from 'node:util';

import type { UnparkJson } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';

import { formatOrderCollision, renderQueueAddLines, renderUnparkLines } from './queue-output.js';

const plain = (s: string) => stripVTControlCharacters(s);

describe('renderQueueAddLines', () => {
  it('queue add text names the issue holding the contested order', () => {
    const lines = renderQueueAddLines('daw', [
      { issue: 11, outcome: 'queued', position: 25, collision: { order: 24, heldBy: [7] } },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.stream === 'out')).toBe(true);
    const second = plain(lines[1]?.text ?? '');
    expect(second).toContain('#7');
    expect(second).toContain('factory:order:24');
    expect(second).toContain('position 25');
  });

  it('queue add text prints only the position line when nothing collided', () => {
    const lines = renderQueueAddLines('daw', [{ issue: 11, outcome: 'queued', position: 1 }]);
    expect(lines).toHaveLength(1);
    expect(plain(lines[0]?.text ?? '')).toBe('#11 queued → lane daw, position 1');
    expect(lines.some((l) => l.text.includes('collide'))).toBe(false);
  });

  it('keeps already-queued on stdout and failed on stderr', () => {
    const lines = renderQueueAddLines('daw', [
      { issue: 1, outcome: 'already-queued', position: 2 },
      { issue: 2, outcome: 'failed', detail: 'boom' },
    ]);
    expect(lines[0]).toEqual({ stream: 'out', text: '#1 already queued — skipped' });
    expect(lines[1]?.stream).toBe('err');
    expect(plain(lines[1]?.text ?? '')).toBe('#2 failed — boom');
  });
});

describe('renderUnparkLines', () => {
  const base: UnparkJson = {
    schemaVersion: 1,
    ok: true,
    action: 'unpark',
    issue: 12,
    lane: 'ops',
    order: 25,
    labelsBefore: [],
    labelsAfter: [],
  };

  it('prints one line without a collision', () => {
    const lines = renderUnparkLines(base);
    expect(lines).toHaveLength(1);
    expect(plain(lines[0] ?? '')).toBe('#12 unparked → lane ops, position 25');
  });

  it('adds a collision line naming the holder', () => {
    const lines = renderUnparkLines({ ...base, collision: { order: 24, heldBy: [7] } });
    expect(lines).toHaveLength(2);
    expect(plain(lines[1] ?? '')).toContain('#7');
  });
});

describe('formatOrderCollision', () => {
  it('joins several holders', () => {
    expect(formatOrderCollision(11, { order: 24, heldBy: [7, 9] }, 25)).toContain('held by #7, #9');
  });
});
