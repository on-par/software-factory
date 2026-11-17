import { availableParallelism } from 'node:os';

export const TEST_MAX_WORKERS_ENV = 'FACTORY_TEST_MAX_WORKERS';

export function resolveTestMaxWorkers(
  env: Readonly<Record<string, string | undefined>>,
  availableCpus: number = availableParallelism(),
): number {
  const raw = env[TEST_MAX_WORKERS_ENV];
  const value = raw?.trim() ?? '';
  if (value === '') return Math.max(1, Math.floor(availableCpus));
  if (/^\d+$/.test(value) && Number(value) >= 1) return Number(value);
  throw new Error(`${TEST_MAX_WORKERS_ENV} must be a positive integer, got '${raw}'`);
}
