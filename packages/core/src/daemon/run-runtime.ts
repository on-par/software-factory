import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { z } from 'zod';
import { redactSecrets } from '../router/failure-detail.js';
import { processAlive, hasOwnedProcesses } from './process-ownership.js';
import { loadRegistry } from './registry.js';

const factoryRunSchema = z.object({
  runId: z.string().uuid(),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  issue: z.number().int().positive(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'interrupted', 'canceled']),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  summary: z.string(),
  prUrl: z.string().nullable(),
});
export type FactoryRun = z.infer<typeof factoryRunSchema>;
export interface RunSubmission {
  expiresAt?: string;
  runId: string;
  repo: string;
  issue: number;
}
export interface RunExecution {
  run: FactoryRun;
  cwd: string;
  ownershipFile?: string;
  signal: AbortSignal;
  output: (text: string) => void;
  /** Persist process ownership before acknowledging launch. */
  started?: (pid: number) => Promise<void>;
}
export type RunExecutor = (execution: RunExecution) => Promise<{ exitCode: number | null; prUrl: string | null }>;
export interface RunRuntime {
  list(): FactoryRun[];
  isExecuting(repo: string): boolean;
  get(runId: string): FactoryRun | undefined;
  submit(input: unknown): Promise<FactoryRun>;
  cancel(runId: string): Promise<FactoryRun>;
  logs(runId: string): { text: string; truncated: boolean };
  stop(): Promise<void>;
}
export class RunRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
interface StoredRun {
  run: FactoryRun;
  log: string;
  truncated: boolean;
  executionPid?: number;
  expiresAt?: string;
}
const MAX_LOG_CHARS = 128 * 1024;
const isActive = (run: FactoryRun) => run.status === 'queued' || run.status === 'running';
const sanitize = (text: string) => redactSecrets(stripVTControlCharacters(text));
const clone = (run: FactoryRun): FactoryRun => ({ ...run, summary: sanitize(run.summary) });

/** Durable single-lane command queue. All mutations serialize before dispatch, and
 * recovery fails closed: interrupted work requires an explicit new run identifier. */
export async function createRunRuntime(options: { registryFile: string; execute: RunExecutor }): Promise<RunRuntime> {
  const file = join(dirname(options.registryFile), 'runs.json');
  const ownershipFile = (runId: string) => join(dirname(file), 'run-groups', `${runId}.ndjson`);
  const ownsLiveProcess = (record: StoredRun) =>
    (record.executionPid !== undefined && processAlive(record.executionPid)) ||
    hasOwnedProcesses(ownershipFile(record.run.runId));
  let records: StoredRun[] = [];
  try {
    records = z
      .array(
        z.object({
          run: factoryRunSchema,
          log: z.string(),
          truncated: z.boolean(),
          executionPid: z.number().int().positive().optional(),
          expiresAt: z.string().datetime().optional(),
        }),
      )
      .parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (new Set(records.map((record) => record.run.runId)).size !== records.length)
    throw new Error('Duplicate run identifiers in durable store');
  const persist = async () => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      `${file}.tmp`,
      JSON.stringify(
        records.map((record) => ({
          ...record,
          run: { ...record.run, summary: sanitize(record.run.summary) },
          log: sanitize(record.log),
        })),
      ),
      { mode: 0o600 },
    );
    await rename(`${file}.tmp`, file);
  };
  let serial: Promise<unknown> = Promise.resolve();
  const mutate = <T>(action: () => Promise<T>): Promise<T> => {
    const pending = serial.then(action);
    serial = pending.catch(() => {});
    return pending;
  };
  let logTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let controller: AbortController | undefined;
  let executing: Promise<void> | undefined;
  let executingRepo: string | undefined;
  let executionSettled: Promise<void> | undefined;
  const cancellations = new Set<string>();
  const now = () => new Date().toISOString();
  const finish = (record: StoredRun, status: FactoryRun['status'], summary: string) => {
    Object.assign(record.run, { status, summary, updatedAt: now(), finishedAt: now() });
  };
  for (const record of records) {
    if (record.executionPid !== undefined && !processAlive(record.executionPid)) delete record.executionPid;
    if (!ownsLiveProcess(record)) await rm(ownershipFile(record.run.runId), { force: true });
    if (isActive(record.run))
      finish(record, 'interrupted', 'Daemon restarted; inspect the previous run before retrying.');
  }
  await persist();
  const find = (runId: string): StoredRun => {
    const record = records.find((record) => record.run.runId === runId);
    if (!record) throw new RunRequestError(404, 'Run not found');
    return record;
  };
  const pump = () => {
    if (stopped || executing) return;
    executing = (async () => {
      while (!stopped) {
        const record = records.find((record) => record.run.status === 'queued');
        if (!record) return;
        const entry = (await loadRegistry(options.registryFile)).repos[record.run.repo];
        await mutate(async () => {
          if (record.run.status !== 'queued' || stopped) return;
          if (records.some((prior) => prior !== record && !isActive(prior.run) && ownsLiveProcess(prior))) {
            finish(record, 'failed', 'Previous run process has not stopped; inspect it before retrying.');
            await persist();
            return;
          }
          if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
            finish(record, 'failed', 'Command expired before execution started.');
          } else if (entry?.state !== 'active') {
            finish(record, 'failed', 'Repository is no longer active.');
          } else {
            Object.assign(record.run, {
              status: 'running',
              startedAt: now(),
              updatedAt: now(),
              summary: 'Running factory ship',
            });
          }
          await persist();
        });
        if (record.run.status !== 'running') continue;
        controller = new AbortController();
        executingRepo = record.run.repo;
        let settle!: () => void;
        executionSettled = new Promise<void>((resolve) => {
          settle = resolve;
        });
        try {
          const result = await options.execute({
            run: clone(record.run),
            cwd: entry.path,
            ownershipFile: ownershipFile(record.run.runId),
            signal: controller.signal,
            started: (pid) =>
              mutate(async () => {
                record.executionPid = pid;
                await persist();
              }),
            output: (text) => {
              record.log += text;
              if (!logTimer && !stopped)
                logTimer = setTimeout(() => {
                  logTimer = undefined;
                  void mutate(persist).catch(() => {
                    stopped = true;
                    controller?.abort();
                  });
                }, 1000);
              if (record.log.length > MAX_LOG_CHARS) {
                record.log = record.log.slice(-MAX_LOG_CHARS);
                record.truncated = true;
              }
            },
          });
          await mutate(async () => {
            delete record.executionPid;
            record.run.exitCode = result.exitCode;
            record.run.prUrl = result.prUrl;
            if (hasOwnedProcesses(ownershipFile(record.run.runId)))
              finish(
                record,
                'interrupted',
                'An owned process is still active; inspect local execution before retrying.',
              );
            if (record.run.status === 'running' && cancellations.has(record.run.runId))
              finish(record, 'canceled', 'Canceled by operator; inspect worktree and PR state before retrying.');
            if (record.run.status === 'running') {
              const success = result.exitCode === 0 && result.prUrl !== null;
              finish(
                record,
                success ? 'succeeded' : 'failed',
                success
                  ? 'Pull request ready for review; check CI before merging.'
                  : `factory ship ended without a verified pull request (exit ${result.exitCode ?? 'signal'}).`,
              );
            }
            await persist();
          });
        } catch (error) {
          await mutate(async () => {
            delete record.executionPid;
            if (record.run.status === 'running')
              finish(
                record,
                cancellations.has(record.run.runId) ? 'canceled' : 'failed',
                error instanceof Error ? error.message : 'Execution failed',
              );
            await persist();
          });
        } finally {
          controller = undefined;
          executingRepo = undefined;
          settle();
          executionSettled = undefined;
        }
      }
    })().finally(() => {
      executing = undefined;
    });
    void executing.catch(() => {
      stopped = true;
      for (const record of records)
        if (isActive(record.run))
          finish(
            record,
            'interrupted',
            'Run persistence failed; repair daemon storage and inspect the previous run before retrying.',
          );
    });
  };
  return {
    isExecuting: (repo) =>
      executingRepo === repo || records.some((record) => record.run.repo === repo && ownsLiveProcess(record)),
    list: () => records.map((record) => clone(record.run)),
    get: (runId) => {
      const record = records.find((record) => record.run.runId === runId);
      return record && clone(record.run);
    },
    submit: (input) =>
      mutate(async () => {
        if (stopped) throw new RunRequestError(503, 'Daemon is stopping');
        if (!input || typeof input !== 'object') throw new RunRequestError(400, 'Invalid run submission');
        const { runId, repo, issue, expiresAt } = input as RunSubmission;
        if (expiresAt !== undefined && !z.string().datetime().safeParse(expiresAt).success)
          throw new RunRequestError(400, 'expiresAt must be an ISO timestamp');
        if (
          typeof runId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId) ||
          typeof repo !== 'string' ||
          !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
          !Number.isSafeInteger(issue) ||
          issue <= 0
        )
          throw new RunRequestError(400, 'Expected runId UUID, repo owner/name, and positive issue number');
        let reconciled = false;
        for (const prior of records) {
          if (!isActive(prior.run) && !ownsLiveProcess(prior)) {
            if (prior.executionPid !== undefined) reconciled = true;
            delete prior.executionPid;
            await rm(ownershipFile(prior.run.runId), { force: true });
          }
        }
        if (reconciled) await persist();
        const existing = records.find((record) => record.run.runId === runId);
        if (existing) {
          if (existing.run.repo !== repo || existing.run.issue !== issue || existing.expiresAt !== expiresAt)
            throw new RunRequestError(409, 'runId already identifies a different request');
          return clone(existing.run);
        }
        if (records.some((record) => !isActive(record.run) && ownsLiveProcess(record)))
          throw new RunRequestError(
            409,
            'Previous run process is still active; wait for it to stop before submitting new work',
          );
        const entry = (await loadRegistry(options.registryFile)).repos[repo];
        if (!entry || entry.state !== 'active')
          throw new RunRequestError(409, 'Repository must be attached and active');
        if (entry.stateRoot)
          throw new RunRequestError(409, 'Explicit runs currently require repository-local factory state');
        if (records.some((record) => record.run.repo === repo && record.run.issue === issue && isActive(record.run)))
          throw new RunRequestError(409, 'Issue already has an active run');
        const timestamp = now();
        const record: StoredRun = {
          run: {
            runId,
            repo,
            issue,
            status: 'queued',
            createdAt: timestamp,
            updatedAt: timestamp,
            startedAt: null,
            finishedAt: null,
            exitCode: null,
            summary: 'Queued',
            prUrl: null,
          },
          log: '',
          truncated: false,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
        records.push(record);
        try {
          await persist();
        } catch (error) {
          records.pop();
          throw error;
        }
        const result = clone(record.run);
        setImmediate(pump);
        return result;
      }),
    cancel: async (runId) => {
      let pending: Promise<void> | undefined;
      await mutate(async () => {
        const record = find(runId);
        if (isActive(record.run)) {
          const running = record.run.status === 'running';
          if (running) {
            cancellations.add(runId);
            record.run.summary = 'Cancellation requested; waiting for the process to stop.';
            pending = executionSettled;
          } else finish(record, 'canceled', 'Canceled before execution.');
          try {
            await persist();
          } finally {
            if (running) controller?.abort();
          }
        }
      });
      await pending;
      return clone(find(runId).run);
    },
    logs: (runId) => {
      const record = find(runId);
      return { text: sanitize(record.log), truncated: record.truncated };
    },
    stop: async () => {
      stopped = true;
      clearTimeout(logTimer);
      try {
        await mutate(async () => {
          for (const record of records)
            if (isActive(record.run))
              finish(record, 'interrupted', 'Daemon stopped; inspect worktree and PR state before retrying.');
          await persist();
        });
      } finally {
        controller?.abort();
        await executing;
      }
    },
  };
}
