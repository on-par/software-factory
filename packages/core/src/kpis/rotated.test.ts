import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';
import { readEvents } from '../events/index.js';
import { listEventSegments } from '../events/tail.js';
import { createLogger } from '../logger/index.js';
import { computeHealthKpis } from './index.js';

describe('computeHealthKpis over a rotated log', () => {
  const tmp = createTempDirs();
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    return tmp.cleanup();
  });

  function write(maxBytes: number): string {
    const dir = tmp.makeSync('factory-kpi-rot-');
    const file = join(dir, 'state', 'events.ndjson');
    const log = createLogger(file, { repo: 'a/b' }, { out: { write: () => true }, env: {}, rotation: { maxBytes } });
    let sec = 0;
    const emit = (issue: string, type: 'issue-title' | 'merged'): void => {
      vi.setSystemTime(new Date(Date.UTC(2026, 6, 20, 0, 0, (sec += 10))));
      log.child({ issue }).info(type, type);
    };
    for (const issue of ['1', '2', '3', '4']) {
      emit(issue, 'issue-title');
      emit(issue, 'merged');
    }
    return file;
  }

  it('equals the unrotated result across three segments plus the live file', () => {
    const rotated = write(300);
    const plain = write(10 * 1024 * 1024);
    expect(listEventSegments(rotated).length).toBeGreaterThanOrEqual(3);
    expect(listEventSegments(plain)).toHaveLength(0);

    const a = computeHealthKpis(readEvents(rotated, { includeSegments: true }), []);
    const b = computeHealthKpis(readEvents(plain, { includeSegments: true }), []);
    expect(a.merged).toBe(4);
    expect(a.merged).toBe(b.merged);
    expect(a.medianCycleTimeMs).toBe(b.medianCycleTimeMs);
    expect(readEvents(rotated, { includeSegments: true }).map((e) => e.msg)).toEqual(
      readEvents(plain).map((e) => e.msg),
    );
    expect(readEvents(rotated).length).toBeLessThan(readEvents(plain).length);
  });
});
