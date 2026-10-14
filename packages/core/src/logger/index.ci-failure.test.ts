import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger } from './index.js';

describe('createLogger — ciFailure payload (#2814)', () => {
  it('includes ciFailure only when passed as extra', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-logger-'));
    try {
      const eventsFile = join(dir, 'events.ndjson');
      const logger = createLogger(eventsFile, { lane: 'app' }, { out: { write: () => {} } });
      const ciFailure = { failingChecks: [{ name: 'CodeQL', conclusion: 'failure' }], alerts: [], truncated: false };

      logger.warn('ci-failed', 'parked', { ciFailure });
      logger.warn('ci-failed', 'again');

      const [withPayload, without] = readFileSync(eventsFile, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      expect(withPayload.ciFailure).toEqual(ciFailure);
      expect(without).not.toHaveProperty('ciFailure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
