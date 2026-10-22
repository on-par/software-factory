// src/logger/rotate.ts — Size-based rotation of the events log into #3174 segments (#1631).

import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  loadFactoryConfigForRepo,
  resolveEventLogRotation,
  type EventLogRotation,
  type FactoryConfig,
} from '../config/index.js';
import { resolveRepoConfigPath } from '../config/repo-config-file.js';
import { eventSegmentFileName, eventSegmentsDir, listEventSegments, liveSegmentId } from '../events/tail.js';

const configCache = new Map<string, FactoryConfig['events']>();

/** Env > repo config `events` (loaded once per events file; any error → defaults) > defaults. */
export function resolveLoggerRotation(eventsFile: string, env: NodeJS.ProcessEnv): EventLogRotation {
  if (!configCache.has(eventsFile)) {
    let events: FactoryConfig['events'];
    try {
      events = loadFactoryConfigForRepo(resolveRepoConfigPath(dirname(dirname(eventsFile)))).events;
    } catch {
      events = undefined;
    }
    configCache.set(eventsFile, events);
  }
  return resolveEventLogRotation({ events: configCache.get(eventsFile) }, env);
}

/** Delete the oldest segments beyond `maxSegments`, never the newest. Returns deleted paths. */
export function pruneEventSegments(eventsFile: string, maxSegments: number): string[] {
  const segments = listEventSegments(eventsFile);
  const doomed = segments.slice(0, Math.max(0, segments.length - Math.max(1, maxSegments)));
  for (const seg of doomed) rmSync(seg.path, { force: true });
  return doomed.map((seg) => seg.path);
}

/**
 * Rename the live file into the segments dir when appending `incomingBytes` would pass `maxBytes`.
 * Never rotates a missing or empty file. Returns the new segment path when it rotated.
 */
export function rotateEventLogIfNeeded(
  eventsFile: string,
  incomingBytes: number,
  rotation: EventLogRotation,
): string | undefined {
  let size: number;
  try {
    size = statSync(eventsFile).size;
  } catch {
    return undefined;
  }
  if (size === 0 || size + incomingBytes <= rotation.maxBytes) return undefined;

  const dir = eventSegmentsDir(eventsFile);
  const target = join(dir, eventSegmentFileName(liveSegmentId(listEventSegments(eventsFile))));
  mkdirSync(dir, { recursive: true });
  renameSync(eventsFile, target);
  if (rotation.maxSegments !== undefined) pruneEventSegments(eventsFile, rotation.maxSegments);
  return target;
}
