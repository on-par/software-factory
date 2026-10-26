// packages/core/src/queue/fleet-leader.ts — single-writer gate for fleet-wide background jobs (#3147, #3142 decision 5).

import { hostname } from 'node:os';

import type { FactoryConfig } from '../config/index.js';

/** This host's id: FACTORY_HOST_ID, else the hostname. The one owner to replace when the persisted host-id resolver lands (#3144). */
export function resolveFactoryHostId(env: NodeJS.ProcessEnv = process.env, host: string = hostname()): string {
  return env.FACTORY_HOST_ID?.trim() || host;
}

/** `fleet.leader` from config, trimmed; undefined when unset or blank (every host runs the job). */
export function resolveFleetLeader(config: FactoryConfig): string | undefined {
  return config.fleet?.leader?.trim() || undefined;
}

/** True when no leader is set, or `hostId` is the leader. */
export function isFleetLeader(leader: string | undefined, hostId: string): boolean {
  const trimmed = leader?.trim();
  return trimmed === undefined || trimmed === '' || trimmed === hostId;
}
