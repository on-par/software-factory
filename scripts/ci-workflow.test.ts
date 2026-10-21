import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  name?: string;
  needs?: string[];
  if?: string;
  'timeout-minutes'?: number;
  strategy?: { matrix?: { shard?: number[] } };
  steps: Step[];
}

const workflow = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')) as {
  name: string;
  jobs: Record<string, Job>;
};
const { jobs } = workflow;

describe('.github/workflows/ci.yml', () => {
  it('keeps the workflow name publish.yml triggers on', () => {
    const publish = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
    expect(workflow.name).toBe('CI');
    expect(publish).toContain('workflows: [CI]');
  });

  it('gates the required `ci` check on static and every test shard, even when one fails or is cancelled', () => {
    const ci = jobs['ci'];
    expect(ci?.name).toBe('ci');
    expect(ci?.needs).toEqual(['static', 'test']);
    // `always()`, not `!cancelled()`: a skipped required check would count as passing.
    expect(ci?.if).toBe('always()');
    const gate = ci?.steps[0];
    expect(gate?.env?.NEEDS).toBe('${{ toJSON(needs) }}');
    expect(gate?.run).toContain(`jq -e 'to_entries | all(.value.result == "success")'`);
    expect(gate?.run).toContain('exit 1');
  });

  it('enforces coverage thresholds and the ratchet only on the merged report', () => {
    const shard = jobs['test'];
    expect(shard?.strategy?.matrix?.shard).toEqual([1, 2, 3]);
    const testStep = shard?.steps.find((s) => s.run?.includes('--shard='));
    expect(testStep?.env?.FACTORY_COVERAGE_SHARD).toBe('1');
    expect(testStep?.run).toContain('--reporter=blob');
    expect(shard?.steps.some((s) => s.run?.includes('coverage-ratchet'))).toBe(false);

    const ciRuns = jobs['ci']?.steps.map((s) => s.run ?? '') ?? [];
    expect(ciRuns).toContain('npm run test -- --merge-reports=vitest-blob');
    expect(ciRuns).toContain('npm run coverage-ratchet');
    expect(JSON.stringify(jobs['ci'])).not.toContain('FACTORY_COVERAGE_SHARD');
  });

  it('caps every job with timeout-minutes (#755)', () => {
    for (const [id, job] of Object.entries(jobs)) expect(job['timeout-minutes'], id).toBeGreaterThan(0);
  });
});

describe('vitest.config.ts coverage under FACTORY_COVERAGE_SHARD', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function coverage(): Promise<{ thresholds?: unknown; reporter?: unknown }> {
    vi.resetModules();
    const { default: config } = await import('../vitest.config.js');
    return config.test?.coverage as { thresholds?: unknown; reporter?: unknown };
  }

  it('drops thresholds and reports on a shard', async () => {
    vi.stubEnv('FACTORY_COVERAGE_SHARD', '1');
    const shard = await coverage();
    expect(shard.thresholds).toBeUndefined();
    expect(shard.reporter).toEqual([]);
  });

  it('keeps thresholds and reports otherwise', async () => {
    vi.stubEnv('FACTORY_COVERAGE_SHARD', '');
    const full = await coverage();
    expect(full.thresholds).toMatchObject({ lines: expect.any(Number), branches: expect.any(Number) });
    expect(full.reporter).toContain('json-summary');
  });
});
