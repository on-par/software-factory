import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readEvents } from '../events/index.js';
import { eventSegmentsDir, rotateEventLog } from '../events/tail.js';
import { createTempDirs } from '../harness/temp-dir.js';
import { computeHealthKpis } from './index.js';

const tmp = createTempDirs();
const at = (sec: number) => new Date(Date.UTC(2026, 6, 20, 0, 0, sec)).toISOString();
const ev = (issue: number, type: string, sec: number) =>
  JSON.stringify({ ts: at(sec), issue: String(issue), type, msg: '' }) + '\n';

describe('KPIs across rotated segments (#1631)', () => {
  afterEach(() => tmp.cleanup());

  it('computes the same merged count and median cycle time over three segments plus live as over one unrotated file', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 8; i++) lines.push(ev(i, 'issue-title', i * 1000), ev(i, 'merged', i * 1000 + i * 60));

    const base = tmp.makeSync('factory-kpi-rot-');
    const a = join(base, 'a', 'events.ndjson');
    const b = join(base, 'b', 'events.ndjson');
    mkdirSync(join(base, 'a'));
    mkdirSync(join(base, 'b'));
    writeFileSync(b, lines.join(''));
    lines.forEach((l, i) => {
      appendFileSync(a, l);
      if ((i + 1) % 4 === 0 && i < 12) rotateEventLog(a);
    });

    expect(readdirSync(eventSegmentsDir(a))).toHaveLength(3);
    const rotated = computeHealthKpis(readEvents(a, { includeSegments: true }), []);
    const single = computeHealthKpis(readEvents(b), []);
    expect(rotated).toEqual(single);
    expect(rotated.merged).toBe(8);
    expect(rotated.medianCycleTimeMs).toBe(single.medianCycleTimeMs);
    expect(computeHealthKpis(readEvents(a), []).merged).toBeLessThan(8);
  });
});
