import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import type { FactoryEvent } from '../types/index.js';
import { createQueueRationaleAuditor } from './queue-rationale-audit.js';
import type { ProjectQueueProjection } from './project-queue-poller.js';

let tmpDir: string | undefined;

function projection(order: string | number): ProjectQueueProjection {
  return {
    refreshedAt: '2026-08-25T12:00:00.000Z',
    items: [
      {
        membership: { projectId: 'PVT_project', itemId: 'PVTI_42' },
        issue: { id: 'I_42', number: 42 },
        lane: 'Build',
        order,
        status: 'ready',
      },
    ],
    diagnostics: [],
  };
}

function readEvents(eventsFile: string): FactoryEvent[] {
  return readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FactoryEvent);
}

function createAuditor() {
  const eventsFile = join(tmpDir as string, 'events.ndjson');
  return {
    auditor: createQueueRationaleAuditor(createLogger(eventsFile, {}, { out: { write: () => {} } })),
    eventsFile,
  };
}

describe('createQueueRationaleAuditor', () => {
  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('records human changes between accepted projections with the complete structured payload', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.observeAcceptedProjection(projection(1));
    auditor.observeAcceptedProjection(projection(2));

    const [event] = readEvents(eventsFile);
    expect(event).toEqual({
      ts: expect.any(String),
      type: 'queue_reprioritized',
      issue: '42',
      msg: 'Queue order changed from 1 to 2',
      level: 'info',
      queueReprioritization: {
        issueId: 'I_42',
        issueNumber: 42,
        field: 'order',
        priorValue: 1,
        newValue: 2,
        actorType: 'human',
        rationale: null,
      },
    });
    expect(new Date(event.ts).toISOString()).toBe(event.ts);
  });

  it('records daemon reprioritizations with the supplied rationale', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.recordDaemonReprioritization({
      issueId: 'I_42',
      issueNumber: 42,
      field: 'order',
      priorValue: 'P2',
      newValue: 'P1',
      rationale: 'Unblocks the release dependency.',
    });

    const [event] = readEvents(eventsFile);
    expect(event).toMatchObject({
      issue: '42',
      type: 'queue_reprioritized',
      queueReprioritization: {
        issueId: 'I_42',
        issueNumber: 42,
        field: 'order',
        priorValue: 'P2',
        newValue: 'P1',
        actorType: 'daemon',
        rationale: 'Unblocks the release dependency.',
      },
    });
  });

  it('serializes an explicit null daemon rationale as a present field', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.recordDaemonReprioritization({
      issueId: 'I_43',
      issueNumber: 43,
      field: 'order',
      priorValue: 3,
      newValue: 1,
      rationale: null,
    });

    const [event] = readEvents(eventsFile);
    expect(event.queueReprioritization).toHaveProperty('rationale', null);
  });
});
