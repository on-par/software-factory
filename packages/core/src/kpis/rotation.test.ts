import { appendFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEvents } from '../events/index.js';
import { eventSegmentsDir, rotateEventLog } from '../events/tail.js';
import { createTempDirs } from '../harness/temp-dir.js';
import type { FactoryEvent } from '../types/index.js';
import { computeHealthKpis } from './index.js';

const tmp = createTempDirs();
afterEach(async () => {
  await tmp.cleanup();
});

function fixture(): FactoryEvent[] {
  const events: FactoryEvent[] = [];
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  for (let issue = 1; issue <= 8; issue++) {
    const start = t0 + issue * 3_600_000;
    events.push({ ts: new Date(start).toISOString(), type: 'plan', issue: String(issue), msg: 'plan' });
    events.push({
      ts: new Date(start + issue * 600_000).toISOString(),
      type: 'merged',
      issue: String(issue),
      msg: 'merged',
    });
  }
  return events;
}

describe('KPIs across rotated segments (#1631)', () => {
  it('computes the same merged count and median cycle time over three segments plus live as over one unrotated file', () => {
    const root = tmp.makeSync('factory-kpi-rotation-');
    const rotated = join(root, 'a', 'events.ndjson');
    const plain = join(root, 'b', 'events.ndjson');
    mkdirSync(dirname(rotated), { recursive: true });
    mkdirSync(dirname(plain), { recursive: true });
    const events = fixture();
    const lines = events.map((e) => JSON.stringify(e) + '\n');
    appendFileSync(plain, lines.join(''));
    // 16 events: 3 segments of 4 lines, then 4 in the live file.
    for (let i = 0; i < lines.length; i++) {
      appendFileSync(rotated, lines[i]!);
      if (i % 4 === 3 && i < 12) rotateEventLog(rotated);
    }

    expect(readdirSync(eventSegmentsDir(rotated))).toHaveLength(3);
    const a = computeHealthKpis(readEvents(rotated, { includeSegments: true }), []);
    const b = computeHealthKpis(readEvents(plain), []);
    expect(a.merged).toBe(8);
    expect(a.merged).toBe(b.merged);
    expect(a.medianCycleTimeMs).toBe(b.medianCycleTimeMs);
    expect(a).toEqual(b);
    expect(computeHealthKpis(readEvents(rotated), []).merged).toBeLessThan(8);
  });
});
