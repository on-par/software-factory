// src/hosted/store-sqlite.ts — node:sqlite-backed persistence for the hosted
// job store (#939). Durability across process restarts, no new dependency:
// node:sqlite (DatabaseSync) ships built into Node >=22.5 / core's >=24
// engines requirement. All idempotency/lease invariant logic lives in
// createHostedJobStoreOverPersistence (store.ts); this file only implements
// the HostedStorePersistence port over two JSON-blob tables.
import { DatabaseSync } from 'node:sqlite';

import {
  createHostedJobStoreOverPersistence,
  type HostedJobStore,
  type HostedJobStoreOptions,
  type HostedStorePersistence,
  type StoredHostedJob,
  type StoredRunner,
} from './store.js';

export interface SqliteHostedJobStoreOptions extends HostedJobStoreOptions {
  /** Path to the SQLite database file. Defaults to ':memory:'. */
  databasePath?: string;
}

export type SqliteHostedJobStore = HostedJobStore & { close(): void };

function bootstrapSchema(db: InstanceType<typeof DatabaseSync>): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;
  if (version === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runners (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
}

function createSqlitePersistence(db: InstanceType<typeof DatabaseSync>): HostedStorePersistence {
  const hasJobStmt = db.prepare('SELECT 1 FROM jobs WHERE id = ?');
  const getJobStmt = db.prepare('SELECT data FROM jobs WHERE id = ?');
  const putJobStmt = db.prepare(
    'INSERT INTO jobs (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  );
  const allJobsStmt = db.prepare('SELECT data FROM jobs');

  const getRunnerStmt = db.prepare('SELECT data FROM runners WHERE id = ?');
  const putRunnerStmt = db.prepare(
    'INSERT INTO runners (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
  );
  const allRunnersStmt = db.prepare('SELECT data FROM runners');

  return {
    hasJob(jobId) {
      return hasJobStmt.get(jobId) !== undefined;
    },
    getJob(jobId) {
      const row = getJobStmt.get(jobId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as StoredHostedJob) : undefined;
    },
    putJob(job) {
      putJobStmt.run(job.request.jobId, JSON.stringify(job));
    },
    jobs() {
      const rows = allJobsStmt.all() as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as StoredHostedJob);
    },
    getRunner(runnerId) {
      const row = getRunnerStmt.get(runnerId) as { data: string } | undefined;
      return row ? (JSON.parse(row.data) as StoredRunner) : undefined;
    },
    putRunner(runner) {
      putRunnerStmt.run(runner.runnerId, JSON.stringify(runner));
    },
    runners() {
      const rows = allRunnersStmt.all() as { data: string }[];
      return rows.map((row) => JSON.parse(row.data) as StoredRunner);
    },
  };
}

export function createSqliteHostedJobStore(options: SqliteHostedJobStoreOptions): SqliteHostedJobStore {
  const { databasePath, ...storeOptions } = options;
  const db = new DatabaseSync(databasePath ?? ':memory:');
  bootstrapSchema(db);
  const persistence = createSqlitePersistence(db);
  const store = createHostedJobStoreOverPersistence(persistence, storeOptions);
  return {
    ...store,
    close: () => db.close(),
  };
}
