import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger } from './index.js';

describe('createLogger — planner escalation kind', () => {
  it('persists each kind and model, and omits an absent kind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    try {
      const logger = createLogger(join(dir, 'events.ndjson'), {}, { out: { write: () => {} } });
      for (const escalateKind of ['missing-info', 'contradiction', 'split'] as const) {
        logger.warn('escalate', 'ESCALATE: planner reason', { model: 'stub-model', escalateKind });
      }
      logger.warn('escalate', 'unclassified', { model: 'stub-model' });

      const events = readFileSync(join(dir, 'events.ndjson'), 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(events.slice(0, 3).map((event) => [event.escalateKind, event.model])).toEqual([
        ['missing-info', 'stub-model'],
        ['contradiction', 'stub-model'],
        ['split', 'stub-model'],
      ]);
      expect(events[3]).not.toHaveProperty('escalateKind');
      expect(events[3].model).toBe('stub-model');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
