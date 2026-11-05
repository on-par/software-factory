// packages/cli/src/cli/run-report.test.ts — --json / --export wrapper around one run (#3907)
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFactoryPaths, workKeyFromIssue, type RunOutcome } from '@on-par/factory-core';
import { runStateFile } from '@on-par/factory-core/internal';
import { createTempDirs } from '@on-par/factory-core/testing';

import { CliExitError } from './errors.js';
import { validateRunReportFlags, withRunReport, type RunReportContext } from './run-report.js';

const tempDirs = createTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

const validate = new Ajv2020().compile(
  JSON.parse(readFileSync(new URL('../../schemas/run-result.schema.json', import.meta.url), 'utf-8')) as object,
);
const route = 'claude' as const;
const shipped: RunOutcome = { state: 'shipped', route, branch: 'factory/5-x', reworkRounds: 1, prNumber: 7 };

function setup() {
  const root = tempDirs.makeSync('run-report-');
  const paths = getFactoryPaths(root);
  mkdirSync(paths.runs, { recursive: true });
  const ctx: RunReportContext = {
    issue: 5,
    repoRoot: root,
    paths,
    getRepo: async () => 'acme/widgets',
  };
  const out: string[] = [];
  const deps = {
    stdout: { write: (s: string) => out.push(s) },
    revParse: (_root: string, ref: string) =>
      ref === 'refs/heads/factory/5-x' ? 'head-sha' : ref === 'origin/HEAD' ? 'base-sha' : null,
  };
  const logAt = (type: string, issue: string, extra: Record<string, unknown> = {}) =>
    appendFileSync(
      paths.events,
      `${JSON.stringify({ ts: new Date(Date.now() + 5).toISOString(), type, issue, msg: 'm', ...extra })}\n`,
    );
  const costAt = (issue: string, model: string, cost: number) =>
    appendFileSync(
      paths.costs,
      `${JSON.stringify({ ts: new Date(Date.now() + 5).toISOString(), issue, task: 't', model, inputTokens: 1, outputTokens: 1, cost })}\n`,
    );
  return { root, paths, ctx, out, deps, logAt, costAt };
}

describe('withRunReport', () => {
  it('json mode writes one schema-valid result as the last stdout line for an opened PR', async () => {
    const s = setup();
    await withRunReport({ json: true }, s.ctx, async (r) => r.recordOutcome(shipped), s.deps);
    expect(s.out).toHaveLength(1);
    expect(s.out[0].endsWith('\n')).toBe(true);
    const result = JSON.parse(s.out[0]);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(result).toMatchObject({
      schemaVersion: 2,
      outcome: 'pr-open',
      branch: 'factory/5-x',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      reworkRounds: 1,
    });
  });

  it('json mode puts PR url, phase timings and USD cost in the result', async () => {
    const s = setup();
    await withRunReport(
      { json: true },
      s.ctx,
      async (r) => {
        // Cost lands inside the phase window, as in a real run; logging it after
        // phase_completed only passed when both writes shared a millisecond.
        s.logAt('phase_started', '5', { phase: 'build' });
        s.costAt('5', 'model-a', 0.25);
        s.logAt('phase_completed', '5', { phase: 'build' });
        s.costAt('6', 'model-b', 5);
        r.recordOutcome(shipped);
      },
      s.deps,
    );
    const result = JSON.parse(s.out[0]);
    expect(result.pr).toEqual({ number: 7, url: 'https://github.com/acme/widgets/pull/7', state: 'open' });
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0]).toMatchObject({ name: 'build', model: 'model-a', attempts: 1 });
    expect(result.phases[0].finishedAt).not.toBeNull();
    expect(result.cost).toEqual({ usd: 0.25, byModel: { 'model-a': 0.25 } });
  });

  it('json mode sends console.log progress to stderr and restores it', async () => {
    const s = setup();
    const originalLog = console.log;
    const originalInfo = console.info;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    let during: typeof console.log | undefined;
    await withRunReport(
      { json: true },
      s.ctx,
      async () => {
        during = console.log;
        console.log('progress line');
        console.info('info line');
      },
      s.deps,
    );
    expect(during).not.toBe(originalLog);
    expect(err).toHaveBeenCalledWith('progress line');
    expect(err).toHaveBeenCalledWith('info line');
    expect(console.log).toBe(originalLog);
    expect(console.info).toBe(originalInfo);
    expect(s.out.join('')).not.toContain('progress line');
  });

  it('a BUILD park still prints outcome parked with an exitReason and re-throws the error', async () => {
    const s = setup();
    const failure = new CliExitError('Run failed: build', 1);
    const thrown = await withRunReport(
      { json: true },
      s.ctx,
      async (r) => {
        r.recordOutcome({ state: 'parked', reason: 'fail' });
        throw failure;
      },
      s.deps,
    ).catch((e) => e);
    expect(thrown).toBe(failure);
    const result = JSON.parse(s.out[0]);
    expect(result.outcome).toBe('parked');
    expect(result.exitReason).toContain('parked: fail');
    expect(validate(result)).toBe(true);
  });

  it('export writes run state, events and costs for the issue on success', async () => {
    const s = setup();
    const dir = join(s.root, 'out');
    writeFileSync(runStateFile(s.paths.runs, workKeyFromIssue(5)), '{"k":1}');
    await withRunReport(
      { export: dir },
      s.ctx,
      async (r) => {
        s.logAt('build', '5');
        s.logAt('build', '6');
        s.costAt('5', 'a', 1);
        s.costAt('6', 'b', 1);
        r.recordOutcome(shipped);
      },
      s.deps,
    );
    expect(s.out).toEqual([]);
    expect(readFileSync(join(dir, 'issue-5.json'), 'utf8')).toBe('{"k":1}');
    expect(existsSync(join(dir, 'issue-5.phase.json'))).toBe(false);
    const events = readFileSync(join(dir, 'events.ndjson'), 'utf8').trim().split('\n');
    expect(events.map((l) => JSON.parse(l).issue)).toEqual(['5']);
    const costs = readFileSync(join(dir, 'costs.jsonl'), 'utf8').trim().split('\n');
    expect(costs.map((l) => JSON.parse(l).model)).toEqual(['a']);
    expect(JSON.parse(readFileSync(join(dir, 'run-result.json'), 'utf8')).outcome).toBe('pr-open');
  });

  it('export writes run state, events and costs for the issue when the run throws', async () => {
    const s = setup();
    const dir = join(s.root, 'out');
    const failure = new Error('boom');
    await expect(
      withRunReport(
        { export: dir },
        s.ctx,
        async () => {
          throw failure;
        },
        s.deps,
      ),
    ).rejects.toBe(failure);
    expect(readFileSync(join(dir, 'events.ndjson'), 'utf8')).toBe('');
    expect(readFileSync(join(dir, 'costs.jsonl'), 'utf8')).toBe('');
    expect(JSON.parse(readFileSync(join(dir, 'run-result.json'), 'utf8'))).toMatchObject({
      outcome: 'failed',
      exitReason: 'boom',
    });
  });

  it('an export failure only warns and never changes the outcome', async () => {
    const s = setup();
    const blocker = join(s.root, 'file');
    writeFileSync(blocker, 'x');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await withRunReport({ export: join(blocker, 'sub') }, s.ctx, async () => {}, s.deps);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('--export failed'));
  });

  it("without --json stdout receives exactly the run's own console.log output", async () => {
    const s = setup();
    const originalLog = console.log;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spied = console.log;
    await withRunReport({}, s.ctx, async () => console.log('hello'), s.deps);
    expect(log).toHaveBeenCalledWith('hello');
    expect(console.log).toBe(spied);
    expect(s.out).toEqual([]);
    log.mockRestore();
    expect(console.log).toBe(originalLog);
  });
});

describe('validateRunReportFlags', () => {
  it.each([
    [{ json: true, stack: true }, 'drop --stack'],
    [{ export: '/o', stack: true }, 'drop --stack'],
    [{ json: true, briefCount: 2 }, 'exactly one brief'],
    [{ export: '' }, '--export needs a directory'],
  ])('%j exits 2', (opts, message) => {
    expect(() => validateRunReportFlags(opts)).toThrow(
      expect.objectContaining({ code: 2, message: expect.stringContaining(message) }),
    );
  });

  it('accepts unflagged and single-run use', () => {
    expect(() => validateRunReportFlags({ stack: true, briefCount: 3 })).not.toThrow();
    expect(() => validateRunReportFlags({ json: true, export: '/o', briefCount: 1 })).not.toThrow();
  });
});
