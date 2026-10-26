import { mkdir, readFile, readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDirs } from '../harness/temp-dir.js';
import type { RouterResult } from '../router/index.js';
import { toWorkKey, workKeyFromIssue } from '../work/index.js';
import { createRunPhaseLogger, writeRunPhaseLog } from './run-phase-log.js';

const key = workKeyFromIssue(17);
const dirs = createTempDirs();
const root = (): Promise<string> => dirs.make('run-phase-log-');
afterEach(() => dirs.cleanup());

function result(output: string, model = 'worker'): RouterResult {
  return {
    model,
    output,
    exitCode: 0,
    attempts: [{ model, ok: true, reason: null, detail: '\u001b[31mclean\u001b[0m' }],
  };
}

describe('run phase logs', () => {
  it('redacts tokens and strips ANSI in headers and output', async () => {
    const logsDir = await root();
    const path = await writeRunPhaseLog({
      logsDir,
      issue: key,
      runId: 'abc',
      phase: 'build',
      result: result('\u001b[32mghp_123456789012345678901234567890\u001b[0m'),
      log: vi.fn(),
    });
    if (!path) throw new Error('expected a written run log');
    const text = await readFile(join(path, 'build.log'), 'utf8');
    expect(text).toContain('final model=worker exitCode=0');
    expect(text).toContain('<secret>');
    expect(text).not.toContain('\u001b');
  });

  it('appends PLAN results and assigns unique rework files', async () => {
    const logger = createRunPhaseLogger({ logsDir: await root(), issue: key, runId: 'abc', log: vi.fn() });
    await logger.plan(result('first'));
    await logger.plan(result('second'));
    await logger.rework(result('check repair'));
    await logger.rework(result('ci repair'));
    const directory = logger.parkMessage('parked').split('\nRun logs: ')[1];
    expect(await readFile(join(directory, 'plan.log'), 'utf8')).toContain('first');
    expect(await readFile(join(directory, 'plan.log'), 'utf8')).toContain('second');
    expect(await readFile(join(directory, 'build-r1.log'), 'utf8')).toContain('check repair');
    expect(await readFile(join(directory, 'build-r2.log'), 'utf8')).toContain('ci repair');
  });

  it('caps total UTF-8 bytes and increases a single truncation marker on append', async () => {
    const logsDir = await root();
    const opts = { logsDir, issue: key, runId: 'large', phase: 'plan' as const, log: vi.fn() };
    await writeRunPhaseLog({ ...opts, result: result('🙂'.repeat(300_000)) });
    await writeRunPhaseLog({ ...opts, result: { ...result('later'), attempts: [] } });
    const text = await readFile(join(logsDir, 'issue-17/run-large/plan.log'), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_048_576);
    expect(text.match(/\[truncated \d+ bytes\]/g)).toHaveLength(1);
    expect(text).toContain('🙂');
  });

  it('retains five run directories and leaves check logs untouched', async () => {
    const logsDir = await root();
    const issueDir = join(logsDir, 'issue-17');
    await mkdir(issueDir, { recursive: true });
    await mkdir(join(issueDir, 'check-r1'));
    for (let i = 0; i < 6; i++) {
      const directory = join(issueDir, `run-${i}`);
      await mkdir(directory);
      const time = new Date(1_700_000_000_000 + i * 1000);
      await utimes(directory, time, time);
    }
    await writeRunPhaseLog({ logsDir, issue: key, runId: '5', phase: 'build', result: result('new'), log: vi.fn() });
    const names = await readdir(issueDir);
    expect(names.filter((name) => name.startsWith('run-')).sort()).toEqual([
      'run-1',
      'run-2',
      'run-3',
      'run-4',
      'run-5',
    ]);
    expect(names).toContain('check-r1');
  });

  it('warns and omits a location when writes fail; disabled logging stays silent', async () => {
    const logsDir = await root();
    await writeFile(join(logsDir, 'issue-17'), 'file blocks directory creation');
    const warn = vi.fn();
    const logger = createRunPhaseLogger({ logsDir, issue: key, runId: 'bad', log: warn });
    await logger.build(result('output'));
    expect(logger.parkMessage('parked')).toBe('parked');
    expect(warn).toHaveBeenCalledWith('warn', expect.stringContaining('write failed'));
    const disabled = createRunPhaseLogger({ issue: key, runId: 'none', log: warn });
    await disabled.plan(result(''));
    expect(disabled.parkMessage('parked')).toBe('parked');
  });

  it('records empty output and attempts', async () => {
    const logsDir = await root();
    await writeRunPhaseLog({
      logsDir,
      issue: key,
      runId: 'empty',
      phase: 'build',
      result: { ...result(''), attempts: [] },
      log: vi.fn(),
    });
    expect(await readFile(join(logsDir, 'issue-17/run-empty/build.log'), 'utf8')).toContain(
      'final model=worker exitCode=0',
    );
  });
});

describe('run phase logs — WorkKey identity', () => {
  it("writes a non-numeric work key's logs under issue-<key>", async () => {
    const logsDir = await root();
    await writeRunPhaseLog({
      logsDir,
      issue: toWorkKey('ENG-12'),
      runId: 'k',
      phase: 'plan',
      result: result('x'),
      log: vi.fn(),
    });
    expect(await readFile(join(logsDir, 'issue-ENG-12/run-k/plan.log'), 'utf8')).toContain('x');
  });

  it('rejects a bare issue number', () => {
    // @ts-expect-error a bare issue number is not a WorkKey
    createRunPhaseLogger({ issue: 17, runId: 'n', log: vi.fn() });
  });
});
