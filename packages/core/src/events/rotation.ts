// src/events/rotation.ts — Resolve the size-rotation policy for the events log (#1631).

import { dirname, resolve } from 'node:path';

import { z } from 'zod';

import { readRepoConfigFile, resolveRepoConfigPath } from '../config/repo-config-file.js';

export interface EventLogRotation {
  /** Rotate once the live file is strictly larger than this many bytes. */
  maxBytes: number;
  /** Keep only the newest N rotated segments; unset keeps all of them. */
  maxSegments?: number;
}

export const DEFAULT_EVENTS_MAX_BYTES = 10 * 1024 * 1024;

/** The optional `events` section of the repo config. */
export const EventsConfigSchema = z
  .object({
    maxBytes: z.number().int().positive().optional(),
    maxSegments: z.number().int().min(1).optional(),
    comment: z.string().optional(),
  })
  .optional();

type ConfigValues = Partial<EventLogRotation>;

const configCache = new Map<string, ConfigValues>();

/** Test hook: forget the per-process repo config reads. */
export function resetEventLogRotationCache(): void {
  configCache.clear();
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function envInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
  return positiveInt(Number(raw.trim()));
}

function readConfigValues(eventsFile: string): ConfigValues {
  const key = resolve(eventsFile);
  const cached = configCache.get(key);
  if (cached) return cached;
  let values: ConfigValues = {};
  try {
    const raw = readRepoConfigFile(resolveRepoConfigPath(dirname(dirname(key))));
    const section = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).events : undefined;
    if (typeof section === 'object' && section !== null) {
      const s = section as Record<string, unknown>;
      values = { maxBytes: positiveInt(s.maxBytes), maxSegments: positiveInt(s.maxSegments) };
    }
  } catch {
    values = {};
  }
  configCache.set(key, values);
  return values;
}

/** Precedence per field: override > env > repo config `events` > default (10 MiB / keep all). */
export function resolveEventLogRotation(
  eventsFile: string,
  env: NodeJS.ProcessEnv = process.env,
  override?: Partial<EventLogRotation>,
): EventLogRotation {
  const cfg = readConfigValues(eventsFile);
  const maxBytes =
    positiveInt(override?.maxBytes) ?? envInt(env.FACTORY_EVENTS_MAX_BYTES) ?? cfg.maxBytes ?? DEFAULT_EVENTS_MAX_BYTES;
  const maxSegments = positiveInt(override?.maxSegments) ?? envInt(env.FACTORY_EVENTS_MAX_SEGMENTS) ?? cfg.maxSegments;
  return maxSegments === undefined ? { maxBytes } : { maxBytes, maxSegments };
}
