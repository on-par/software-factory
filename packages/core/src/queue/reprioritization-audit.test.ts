import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger } from '../logger/index.js';
import type { ProjectQueueProjection } from '../projects/project-queue-poller.js';
import type { FactoryEvent, QueueReprioritizationRecord } from '../types/index.js';
import type { QueueRationaleCommentClient } from './reprioritization-audit.js';
import { createQueueRationaleAuditor, renderReprioritizationComment } from './reprioritization-audit.js';

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

function createAuditor(commentClient?: QueueRationaleCommentClient) {
  const eventsFile = join(tmpDir as string, 'events.ndjson');
  return {
    auditor: createQueueRationaleAuditor(createLogger(eventsFile, {}, { out: { write: () => {} } }), {
      commentClient,
    }),
    eventsFile,
  };
}

function fakeCommentClient(): QueueRationaleCommentClient & {
  calls: Array<{ issueNumber: number; body: string }>;
} {
  const calls: Array<{ issueNumber: number; body: string }> = [];
  return {
    calls,
    async commentOnIssue(input) {
      calls.push(input);
    },
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

    await auditor.observeAcceptedProjection(projection('Build', 1));

    expect(existsSync(eventsFile)).toBe(false);
  });

  it('records a human lane change between accepted projections', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Check', 1));

    expectHumanReprioritization(readEvents(eventsFile)[0], 'lane', 'Build', 'Check');
  });

  it('records a human order change between accepted projections', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Build', 2));

    expectHumanReprioritization(readEvents(eventsFile)[0], 'order', 1, 2);
  });

  it('records simultaneous lane and order changes in lane-then-order sequence', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Ship', 2));

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

    await auditor.observeAcceptedProjection(projectionForItems([original]));
    await auditor.observeAcceptedProjection(projectionForItems([added]));

    expect(existsSync(eventsFile)).toBe(false);
  });

  it('records daemon reprioritizations with the supplied rationale', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    await auditor.recordDaemonReprioritization({
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

    await auditor.recordDaemonReprioritization({
      issueId: 'I_43',
      issueNumber: 43,
      field: 'order',
      priorValue: 3,
      newValue: 1,
      rationale: null,
    });

    expect(readEvents(eventsFile)[0].queueReprioritization).toHaveProperty('rationale', null);
  });

  it('posts a comment for a human lane change when a comment client is injected', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const commentClient = fakeCommentClient();
    const { auditor, eventsFile } = createAuditor(commentClient);

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Check', 1));

    expect(commentClient.calls).toHaveLength(1);
    expect(commentClient.calls[0].issueNumber).toBe(42);
    expect(commentClient.calls[0].body).toContain('**Field:** lane');
    expect(commentClient.calls[0].body).toContain('**Previous:** Build');
    expect(commentClient.calls[0].body).toContain('**New:** Check');
    expect(commentClient.calls[0].body).toContain('**Actor:** human');

    expectHumanReprioritization(readEvents(eventsFile)[0], 'lane', 'Build', 'Check');
  });

  it('posts a comment for a human order change when a comment client is injected', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const commentClient = fakeCommentClient();
    const { auditor } = createAuditor(commentClient);

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Build', 2));

    expect(commentClient.calls).toHaveLength(1);
    expect(commentClient.calls[0].body).toContain('**Field:** order');
    expect(commentClient.calls[0].body).toContain('**Previous:** 1');
    expect(commentClient.calls[0].body).toContain('**New:** 2');
  });

  it('posts two comments (lane then order) for simultaneous lane and order changes', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const commentClient = fakeCommentClient();
    const { auditor } = createAuditor(commentClient);

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Ship', 2));

    expect(commentClient.calls).toHaveLength(2);
    expect(commentClient.calls[0].body).toContain('**Field:** lane');
    expect(commentClient.calls[1].body).toContain('**Field:** order');
  });

  it('posts a comment with the rationale for a daemon reprioritization', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const commentClient = fakeCommentClient();
    const { auditor } = createAuditor(commentClient);

    await auditor.recordDaemonReprioritization({
      issueId: 'I_42',
      issueNumber: 42,
      field: 'lane',
      priorValue: 'Build',
      newValue: 'Ship',
      rationale: 'Unblocks the release dependency.',
    });

    expect(commentClient.calls).toHaveLength(1);
    expect(commentClient.calls[0].body).toContain('**Actor:** daemon');
    expect(commentClient.calls[0].body).toContain('**Rationale:** Unblocks the release dependency.');
  });

  it('posts a comment without a Rationale line when the record rationale is null', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const commentClient = fakeCommentClient();
    const { auditor } = createAuditor(commentClient);

    await auditor.recordDaemonReprioritization({
      issueId: 'I_43',
      issueNumber: 43,
      field: 'order',
      priorValue: 3,
      newValue: 1,
      rationale: null,
    });

    expect(commentClient.calls).toHaveLength(1);
    expect(commentClient.calls[0].body).not.toContain('**Rationale:**');
  });

  it('posts no comment when no comment client is injected', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const { auditor, eventsFile } = createAuditor();

    await auditor.observeAcceptedProjection(projection('Build', 1));
    await auditor.observeAcceptedProjection(projection('Check', 1));

    expectHumanReprioritization(readEvents(eventsFile)[0], 'lane', 'Build', 'Check');
  });

  it('swallows a rejecting comment client, still writes the event, and logs a warn event', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'factory-queue-rationale-'));
    const eventsFile = join(tmpDir, 'events.ndjson');
    const commentClient: QueueRationaleCommentClient = {
      commentOnIssue: async () => {
        throw new Error('GitHub API unavailable');
      },
    };
    const auditor = createQueueRationaleAuditor(createLogger(eventsFile, {}, { out: { write: () => {} } }), {
      commentClient,
    });

    await expect(
      auditor.recordDaemonReprioritization({
        issueId: 'I_42',
        issueNumber: 42,
        field: 'lane',
        priorValue: 'Build',
        newValue: 'Ship',
        rationale: null,
      }),
    ).resolves.toBeUndefined();

    const events = readEvents(eventsFile);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('queue_reprioritized');
    expect(events[1]).toMatchObject({
      type: 'queue_rationale_comment_failed',
      issue: '42',
      level: 'warn',
    });
  });
});

describe('renderReprioritizationComment', () => {
  function record(overrides: Partial<QueueReprioritizationRecord> = {}): QueueReprioritizationRecord {
    return {
      issueId: 'I_42',
      issueNumber: 42,
      field: 'lane',
      priorValue: 'Build',
      newValue: 'Check',
      actorType: 'human',
      rationale: null,
      ...overrides,
    };
  }

  it('omits the rationale line when the record rationale is null', () => {
    const body = renderReprioritizationComment(record({ rationale: null }));

    expect(body).toContain('**Field:** lane');
    expect(body).toContain('**Previous:** Build');
    expect(body).toContain('**New:** Check');
    expect(body).toContain('**Actor:** human');
    expect(body).not.toContain('**Rationale:**');
  });

  it('includes the rationale line when the record rationale is present', () => {
    const body = renderReprioritizationComment(record({ actorType: 'daemon', rationale: 'Unblocks release.' }));

    expect(body).toContain('**Actor:** daemon');
    expect(body).toContain('**Rationale:** Unblocks release.');
  });
});
