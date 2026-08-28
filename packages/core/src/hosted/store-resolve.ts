// src/hosted/store-resolve.ts — config-driven adapter selection (#939).
// Depends on both store.ts (memory) and store-sqlite.ts (sqlite) so neither
// backend module needs to know about the other.
import { createHostedJobStore, type HostedJobStore, type HostedJobStoreOptions } from './store.js';
import { createSqliteHostedJobStore, type SqliteHostedJobStore } from './store-sqlite.js';

export type HostedJobStoreBackend = 'memory' | 'sqlite';

export interface ResolveHostedJobStoreOptions extends HostedJobStoreOptions {
  /** Storage backend to use. Defaults to 'memory'. */
  backend?: HostedJobStoreBackend;
  /** SQLite only. Defaults to ':memory:'. */
  databasePath?: string;
}

export interface ResolveSqliteHostedJobStoreOptions extends ResolveHostedJobStoreOptions {
  backend: 'sqlite';
}

/** Defaults to the in-memory store. */
export function resolveHostedJobStore(options: ResolveSqliteHostedJobStoreOptions): SqliteHostedJobStore;
export function resolveHostedJobStore(options: ResolveHostedJobStoreOptions): HostedJobStore;
export function resolveHostedJobStore(options: ResolveHostedJobStoreOptions): HostedJobStore {
  const { backend, databasePath, ...storeOptions } = options;
  if (backend === 'sqlite') {
    return createSqliteHostedJobStore({ ...storeOptions, databasePath: databasePath ?? ':memory:' });
  }
  return createHostedJobStore(storeOptions);
}
