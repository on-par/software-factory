import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDaemonRunExclusive,
  daemonRunFile,
  isValidRunId,
  readDaemonRun,
  type DaemonRunRecord,
  writeDaemonRun,
} from './run-store.js';

const record: DaemonRunRecord = {
  runId: 'R',
  repo: 'owner/repo',
  issue: 1,
  status: 'queued',
  submittedAt: 't',
  updatedAt: 't',
};
const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'run-store-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('run store', () => {
  it.each(['R', 'run-1', 'a.b_c-1', 'a'.repeat(64)])('accepts safe run id %s', (id) =>
    expect(isValidRunId(id)).toBe(true),
  );
  it.each(['', '..', '.hidden', '-lead', 'a/b', 'a\\b', 'a'.repeat(65), 42, null, undefined])(
    'rejects unsafe run id %#',
    (id) => expect(isValidRunId(id)).toBe(false),
  );
  it('builds only safe record paths', async () => {
    const dir = await temp();
    expect(daemonRunFile(join(dir, 'runs'), 'R')).toBe(join(dir, 'runs', 'R.json'));
    expect(() => daemonRunFile(dir, '../evil')).toThrow(RangeError);
    expect(() => daemonRunFile(dir, '')).toThrow(RangeError);
  });
  it('claims a record exactly once without changing its bytes', async () => {
    const file = daemonRunFile(join(await temp(), 'runs'), 'R');
    expect(await createDaemonRunExclusive(file, record)).toBe('created');
    const bytes = await readFile(file, 'utf-8');
    expect(await createDaemonRunExclusive(file, { ...record, issue: 2 })).toBe('exists');
    expect(await readFile(file, 'utf-8')).toBe(bytes);
  });
  it('rethrows create errors other than EEXIST', async () => {
    const dir = await temp();
    const parent = join(dir, 'file');
    await writeFile(parent, 'x');
    await expect(createDaemonRunExclusive(join(parent, 'R.json'), record)).rejects.toThrow();
  });
  it('tolerates missing and corrupt records and strips unknown keys', async () => {
    const dir = await temp();
    const file = join(dir, 'R.json');
    await expect(readDaemonRun(file)).resolves.toBeNull();
    for (const value of [
      'not json{{{',
      '[]',
      '"str"',
      '{"runId":"R"}',
      '{"runId":"R","repo":"x","issue":1,"status":"bogus","submittedAt":"t","updatedAt":"t"}',
      '{"runId":"../x","repo":"x","issue":1,"status":"queued","submittedAt":"t","updatedAt":"t"}',
    ]) {
      await writeFile(file, value);
      await expect(readDaemonRun(file)).resolves.toBeNull();
    }
    await writeFile(file, JSON.stringify({ ...record, startedAt: 's', finishedAt: 'f', detail: 'd', extra: true }));
    await expect(readDaemonRun(file)).resolves.toEqual({ ...record, startedAt: 's', finishedAt: 'f', detail: 'd' });
  });
  it('atomically overwrites records without leaving a tmp file', async () => {
    const dir = await temp();
    const file = join(dir, 'runs', 'R.json');
    await writeDaemonRun(file, record);
    await writeDaemonRun(file, { ...record, status: 'succeeded' });
    await expect(readDaemonRun(file)).resolves.toMatchObject({ status: 'succeeded' });
    expect(await readdir(join(dir, 'runs'))).toEqual(['R.json']);
  });
});
