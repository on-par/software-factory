// src/events/rotation.ts — Size-rotation policy for the events log (#1631).
// Per field: override > env > repo config `events` section > default. Invalid values are ignored (ADR-0160).

import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { readRepoConfigFile, resolveRepoConfigPath } from '../config/repo-config-file.js';
import { runConfigSource } from '../config/run-config-source.js';

export interface EventLogRotation {
  maxBytes: number;
  maxSegments?: number;
}

export const DEFAULT_EVENTS_MAX_BYTES = 10 * 1024 * 1024;

/** Lenient on purpose: an invalid value loads as unset instead of failing the whole config (ADR-0160). */
export const EventsConfigSchema = z
  .object({
    maxBytes: z.number().int().positive().optional().catch(undefined),
    maxSegments: z.number().int().min(1).optional().catch(undefined),
    comment: z.string().optional().catch(undefined),
  })
  .optional()
  .catch(undefined);

const configCache = new Map<string, Partial<EventLogRotation>>();

export function resetEventLogRotationCache(): void {
  configCache.clear();
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function envInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return positiveInt(Number(raw));
}

function readConfigPolicy(eventsFile: string): Partial<EventLogRotation> {
  try {
    const snapshot = runConfigSource();
    // The events file is <root>/state/events.ndjson; the repo config lives at <root>.
    const raw: unknown =
      snapshot !== undefined
        ? JSON.parse(snapshot)
        : readRepoConfigFile(resolveRepoConfigPath(dirname(dirname(resolve(eventsFile)))));
    const section = (raw as { events?: unknown } | null | undefined)?.events;
    if (typeof section !== 'object' || section === null) return {};
    const { maxBytes, maxSegments } = section as Record<string, unknown>;
    return { maxBytes: positiveInt(maxBytes), maxSegments: positiveInt(maxSegments) };
  } catch {
    return {};
  }
}

export function resolveEventLogRotation(
  eventsFile: string,
  env: NodeJS.ProcessEnv = process.env,
  override?: Partial<EventLogRotation>,
): EventLogRotation {
  const key = resolve(eventsFile);
  let fromConfig = configCache.get(key);
  if (!fromConfig) {
    fromConfig = readConfigPolicy(eventsFile);
    configCache.set(key, fromConfig);
  }
  const maxBytes =
    positiveInt(override?.maxBytes) ??
    envInt(env.FACTORY_EVENTS_MAX_BYTES) ??
    fromConfig.maxBytes ??
    DEFAULT_EVENTS_MAX_BYTES;
  const maxSegments =
    positiveInt(override?.maxSegments) ?? envInt(env.FACTORY_EVENTS_MAX_SEGMENTS) ?? fromConfig.maxSegments;
  return maxSegments === undefined ? { maxBytes } : { maxBytes, maxSegments };
}
