import { createTempDirs } from '@on-par/factory-core/testing';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { checkJsonSchema, type CheckJson } from './json-contract.js';
import { runIssueCheck } from './ready-check.js';

const tempDirs = createTempDirs();
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./__fixtures__/json/${name}`, import.meta.url), 'utf-8')) as unknown;

afterEach(async () => {
  await tempDirs.cleanup();
});

describe('check JSON wire contract', () => {
  it('matches the check golden from the real producer and validates it', async () => {
    const lines: string[] = [];
    const ready = JSON.stringify({
      schemaVersion: 1,
      verdict: 'ready',
      summary: 'Clear.',
      assumptions: [],
      questions: [],
    });
    const report: CheckJson = await runIssueCheck(
      7,
      { json: true },
      {
        getIssue: async () => ({ title: 'Reset password', body: 'Customers cannot reset their password.' }),
        runModel: async () => ({ model: 'fake-model', output: ready, cost: 0.02 }),
        readinessCacheDir: tempDirs.makeSync('check-cache-'),
        log: (line) => lines.push(line),
      },
    );
    expect(report.exitCode).toBe(0);
    expect(lines).toHaveLength(1);
    const output = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(output).toEqual(fixture('check.json'));
    expect(output).toMatchObject({ verdict: 'ready', exitCode: 0, fields: { pass: false } });
    expect(checkJsonSchema.parse(output)).toEqual(output);
  });
});
