import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { FactoryEvent } from '../types/index.js';
import { createQueueRationaleAuditor } from './reprioritization-audit.js';

let tmpDir: string | undefined;

function projection(lane: string, order: string | number): ProjectQueueProjection {
  return {
    refreshedAt: '2026-08-25T12:00:00.000Z',
    items: [
      {
        membership: { projectId: 'PVT_project', itemId: 'PVTI_42' },
        issue: { id: 'I_42', number: 42 },
        lane,
        order,
        status: 'ready',
      },
    ],
    diagnostics: [],
  };
}

function projectionForItems(items: ProjectQueueProjection['items']): ProjectQueueProjection {
  return { refreshedAt: '2026-08-25T12:00:00.000Z', items, diagnostics: [] };
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

function expectHumanReprioritization(
  event: FactoryEvent,
  field: 'lane' | 'order',
  priorValue: string | number,
  newValue: string | number,
): void {
  expect(event).toMatchObject({
    type: 'queue_reprioritized',
    issue: '42',
    msg: `Queue ${field} changed from ${priorValue} to ${newValue}`,
    level: 'info',
    queueReprioritization: {
      issueId: 'I_42',
      issueNumber: 42,
      field,
      priorValue,
      newValue,
      actorType: 'human',
      rationale: null,
    },
  });
  expect(new Date(event.ts).toISOString()).toBe(event.ts);
}

describe('createQueueRationaleAuditor', () => {
  afterEach(async () => {
    if (tmpDir !== undefined) {
      await rm(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('uses the first accepted projection as a silent baseline', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.observeAcceptedProjection(projection('Build', 1));

    expect(existsSync(eventsFile)).toBe(false);
  });

  it('records a human lane change between accepted projections', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.observeAcceptedProjection(projection('Build', 1));
    auditor.observeAcceptedProjection(projection('Check', 1));

    expectHumanReprioritization(readEvents(eventsFile)[0], 'lane', 'Build', 'Check');
  });

  it('records a human order change between accepted projections', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.observeAcceptedProjection(projection('Build', 1));
    auditor.observeAcceptedProjection(projection('Build', 2));

    expectHumanReprioritization(readEvents(eventsFile)[0], 'order', 1, 2);
  });

  it('records simultaneous lane and order changes in lane-then-order sequence', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.observeAcceptedProjection(projection('Build', 1));
    auditor.observeAcceptedProjection(projection('Ship', 2));

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(2);
    expectHumanReprioritization(events[0], 'lane', 'Build', 'Ship');
    expectHumanReprioritization(events[1], 'order', 1, 2);
  });

  it('does not audit newly added or removed items without a prior/current pair', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();
    const original = projection('Build', 1).items[0];
    const added = {
      ...original,
      membership: { ...original.membership, itemId: 'PVTI_43' },
      issue: { id: 'I_43', number: 43 },
      lane: 'Ship',
      order: 2,
    };

    auditor.observeAcceptedProjection(projectionForItems([original]));
    auditor.observeAcceptedProjection(projectionForItems([added]));

    expect(existsSync(eventsFile)).toBe(false);
  });

  it('records daemon reprioritizations with the supplied rationale', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    auditor.recordDaemonReprioritization({
      issueId: 'I_42',
      issueNumber: 42,
      field: 'lane',
      priorValue: 'Build',
      newValue: 'Ship',
      rationale: 'Unblocks the release dependency.',
    });

    expect(readEvents(eventsFile)[0]).toMatchObject({
      type: 'queue_reprioritized',
      queueReprioritization: {
        issueId: 'I_42',
        issueNumber: 42,
        field: 'lane',
        priorValue: 'Build',
        newValue: 'Ship',
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

    expect(readEvents(eventsFile)[0].queueReprioritization).toHaveProperty('rationale', null);
  });
});
