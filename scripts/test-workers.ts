/**
 * Worker count for the root vitest run. `vitest.config.ts` reads it so
 * `npm test`, `npx vitest run` and scripts/verify.sh share one knob instead of
 * a hard-coded `--maxWorkers=1`. Unset or blank means 4 workers; `1` runs serially.
 */
export const TEST_MAX_WORKERS_ENV = 'FACTORY_TEST_MAX_WORKERS';

// Chosen from docs/research/coverage-worker-scaling-2752.md (4 workers: ~56s,
// ~211 MB peak heap per worker, no OOM) and capped at the 4 vCPUs of CI's
// ubuntu-latest runner.
const DEFAULT_TEST_MAX_WORKERS = 4;

export function resolveTestMaxWorkers(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[TEST_MAX_WORKERS_ENV];
  const value = raw?.trim() ?? '';
  // Unset or blank uses the bounded parallel default; '1' is the serial opt-out.
  if (value === '') return DEFAULT_TEST_MAX_WORKERS;
  if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new Error(`${TEST_MAX_WORKERS_ENV} must be a positive integer, got '${raw}'`);
}
