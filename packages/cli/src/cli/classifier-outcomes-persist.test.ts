import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFactoryPaths, type FactoryEvent, type PrSource } from '@on-par/factory-core';
import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { persistClassifierOutcomes } from './classifier-outcomes-persist.js';

const tmp = createTempDirs();
afterEach(() => tmp.cleanup());

describe('persistClassifierOutcomes', () => {
  it('writes nothing when no PR source yields an outcome', () => {
    const paths = getFactoryPaths(tmp.makeSync('factory-outcomes-'));
    persistClassifierOutcomes(paths, [], [], { now: '2026-01-10T00:00:00.000Z', windowDays: 14 });
    expect(existsSync(join(paths.state, 'classifier-outcomes.jsonl'))).toBe(false);
  });

  it('joins a classified, merged PR and appends it to the outcomes file', () => {
    const paths = getFactoryPaths(tmp.makeSync('factory-outcomes-'));
    const event: FactoryEvent = {
      type: 'pr-classified',
      issue: '7',
      msg: 'classified',
      ts: '2026-01-01T00:00:00.000Z',
      prClassification: {
        modelClass: 'B',
        floorClass: 'B',
        finalClass: 'B',
        model: 'm',
        promptVersion: 'p1',
        policyVersion: 'f1',
        diffSha: 'sha',
        adrIds: [],
        costUsd: null,
        claims: [],
        unsupportedClaims: [],
        notInspected: [],
        droppedClaims: 0,
      },
    };
    const source: PrSource = {
      issue: '7',
      prNumber: 42,
      commits: [],
      approvals: [],
      mergedAt: '2026-01-02T00:00:00.000Z',
      closedAt: null,
    };
    const opts = { now: '2026-03-01T00:00:00.000Z', windowDays: 14 };
    persistClassifierOutcomes(paths, [event], [source], opts);
    persistClassifierOutcomes(paths, [event], [source], opts);
    const lines = readFileSync(paths.classifierOutcomes, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ issue: '7', prNumber: 42 });
  });
});
