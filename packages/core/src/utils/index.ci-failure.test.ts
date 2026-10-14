import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { logEvent } from './index.js';

describe('logEvent — ciFailure payload (#2814)', () => {
  it('writes ciFailure onto the line only when passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'factory-events-'));
    try {
      const eventsFile = join(dir, 'events.ndjson');
      const ciFailure = { failingChecks: [{ name: 'CodeQL', conclusion: 'failure' }], alerts: [], truncated: false };

      logEvent(eventsFile, 'ci-failed', 5, 'parked', { ciFailure });
      logEvent(eventsFile, 'ci-failed', 5, 'parked again');

      const lines = readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean);
      expect(JSON.parse(lines[0]).ciFailure).toEqual(ciFailure);
      expect(JSON.parse(lines[1])).not.toHaveProperty('ciFailure');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
