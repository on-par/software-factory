import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveTestMaxWorkers } from './test-workers.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('resolveTestMaxWorkers', () => {
  it('defaults to 4 workers when FACTORY_TEST_MAX_WORKERS is unset or blank', () => {
    expect(resolveTestMaxWorkers({})).toBe(4);
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: '' })).toBe(4);
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: '  ' })).toBe(4);
  });

  it('returns 1 when FACTORY_TEST_MAX_WORKERS is 1 (serial opt-out)', () => {
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: '1' })).toBe(1);
  });

  it('returns the configured positive integer', () => {
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: '4' })).toBe(4);
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: ' 8 ' })).toBe(8);
    expect(resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: '2' })).toBe(2);
  });

  it.each(['0', '-2', '2.5', 'abc', '50%', '4abc'])('rejects malformed value %j', (value) => {
    expect(() => resolveTestMaxWorkers({ FACTORY_TEST_MAX_WORKERS: value })).toThrow(
      new RegExp(`FACTORY_TEST_MAX_WORKERS.*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('package.json test script and vitest.config.ts carry no hard-coded serial settings', () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).not.toMatch(/--maxWorkers/);
    const config = readFileSync(`${ROOT}vitest.config.ts`, 'utf8');
    expect(config).not.toMatch(/fileParallelism:\s*false/);
    expect(config).toContain('resolveTestMaxWorkers');
  });

  it('vitest.config.ts documents the default worker count and FACTORY_TEST_MAX_WORKERS', () => {
    const config = readFileSync(`${ROOT}vitest.config.ts`, 'utf8');
    expect(config).toContain('FACTORY_TEST_MAX_WORKERS');
    expect(config).toMatch(/4 workers/);
    expect(config).toMatch(/FACTORY_TEST_MAX_WORKERS=1/);
    expect(config).not.toContain('Keep files serial by default');
  });
});
