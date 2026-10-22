// src/config/event-log-rotation.ts — Event-log rotation settings resolution (#1631).

export interface EventLogRotation {
  maxBytes: number;
  /** Keep only the newest N rotated segments; unset keeps all. */
  maxSegments?: number;
}

export const DEFAULT_EVENT_LOG_MAX_BYTES = 10 * 1024 * 1024;

function positiveIntEnv(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return raw?.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Env (positive integers only) > config `events` section > defaults (10 MB, keep all). */
export function resolveEventLogRotation(
  config: { events?: { maxBytes?: number; maxSegments?: number } | undefined } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EventLogRotation {
  const maxSegments = positiveIntEnv(env.FACTORY_EVENTS_MAX_SEGMENTS) ?? config?.events?.maxSegments;
  return {
    maxBytes: positiveIntEnv(env.FACTORY_EVENTS_MAX_BYTES) ?? config?.events?.maxBytes ?? DEFAULT_EVENT_LOG_MAX_BYTES,
    ...(maxSegments !== undefined ? { maxSegments } : {}),
  };
}
