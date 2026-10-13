/**
 * Worker count for the root vitest run. `vitest.config.ts` reads it so
 * `npm test`, `npx vitest run` and scripts/verify.sh share one knob instead of
 * a hard-coded `--maxWorkers=1`.
 */
export const TEST_MAX_WORKERS_ENV = 'FACTORY_TEST_MAX_WORKERS';

export function resolveTestMaxWorkers(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TEST_MAX_WORKERS_ENV];
  const value = raw?.trim() ?? '';
  // Serial is today's default; picking a parallel default is a separate decision
  // (see docs/research/coverage-worker-scaling-2752.md).
  if (value === '') return 1;
  if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new Error(`${TEST_MAX_WORKERS_ENV} must be a positive integer, got '${raw}'`);
}
