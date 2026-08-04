import { describe, expect, it, vi } from 'vitest';

import type { MonteCarloOptions, MonteCarloReport } from './monte-carlo.js';
import {
  MONTE_CARLO_CLI_USAGE,
  parseMonteCarloArgs,
  runMonteCarloCli,
  simMonteCarloIssues,
  type MonteCarloCliDeps,
} from './monte-carlo-cli.js';

function fakeReport(overrides: Partial<MonteCarloReport> = {}): MonteCarloReport {
  return {
    runs: 1,
    totalIssues: 1,
    totals: { shipped: 1, parked: 0, escalated: 0 },
    rates: { shipped: 1, parked: 0, escalated: 0, failure: 0 },
    modelCalls: 2,
    githubCalls: 3,
    injectedFailures: 0,
    runSummaries: [
      {
        run: 0,
        seed: 1,
        issues: 1,
        totals: { shipped: 1, parked: 0, escalated: 0 },
        modelCalls: 2,
        githubCalls: 3,
        injectedFailures: 0,
      },
    ],
    thresholds: {},
    breaches: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MonteCarloCliDeps> = {}): {
  deps: MonteCarloCliDeps;
  out: string[];
  err: string[];
  runCalls: MonteCarloOptions[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const runCalls: MonteCarloOptions[] = [];
  const deps: MonteCarloCliDeps = {
    write: (line) => out.push(line),
    writeErr: (line) => err.push(line),
    run: async (options) => {
      runCalls.push(options);
      return fakeReport();
    },
    ...overrides,
  };
  return { deps, out, err, runCalls };
}

describe('parseMonteCarloArgs', () => {
  it('parses defaults', () => {
    const args = parseMonteCarloArgs([]);
    expect(args).toEqual({
      runs: 10,
      issues: 3,
      seed: 1,
      concurrency: 1,
      format: 'table',
      thresholds: {},
      help: false,
    });
  });

  it('parses every flag', () => {
    const args = parseMonteCarloArgs([
      '--runs',
      '20',
      '--issues',
      '5',
      '--seed',
      '42',
      '--concurrency',
      '4',
      '--format',
      'json',
      '--failure-rate',
      '0.3',
      '--max-failure-rate',
      '0.2',
      '--max-park-rate',
      '0.1',
      '--max-escalation-rate',
      '0.05',
      '--output',
      'report.json',
    ]);
    expect(args).toEqual({
      runs: 20,
      issues: 5,
      seed: 42,
      concurrency: 4,
      format: 'json',
      failureRate: 0.3,
      thresholds: { maxFailureRate: 0.2, maxParkRate: 0.1, maxEscalationRate: 0.05 },
      output: 'report.json',
      help: false,
    });
  });

  it('-h and --help set help', () => {
    expect(parseMonteCarloArgs(['-h']).help).toBe(true);
    expect(parseMonteCarloArgs(['--help']).help).toBe(true);
  });

  it('--jitter sets jitterPath', () => {
    expect(parseMonteCarloArgs(['--jitter', 'config.json']).jitterPath).toBe('config.json');
  });

  it('throws on an unknown flag', () => {
    expect(() => parseMonteCarloArgs(['--bogus'])).toThrow('unknown flag: --bogus');
  });

  it('throws on non-numeric or non-positive --runs', () => {
    expect(() => parseMonteCarloArgs(['--runs', 'abc'])).toThrow('invalid flag: --runs');
    expect(() => parseMonteCarloArgs(['--runs', '0'])).toThrow('invalid flag: --runs');
    expect(() => parseMonteCarloArgs(['--runs', '1.5'])).toThrow('invalid flag: --runs');
  });

  it('--seed allows 0', () => {
    expect(parseMonteCarloArgs(['--seed', '0']).seed).toBe(0);
  });

  it('throws on an out-of-range rate flag', () => {
    expect(() => parseMonteCarloArgs(['--max-failure-rate', '1.5'])).toThrow('invalid flag: --max-failure-rate');
    expect(() => parseMonteCarloArgs(['--failure-rate', '-0.1'])).toThrow('invalid flag: --failure-rate');
  });

  it('throws on an invalid --format value', () => {
    expect(() => parseMonteCarloArgs(['--format', 'markdown'])).toThrow('invalid flag: --format');
  });

  it('--jitter and --failure-rate together throw', () => {
    expect(() => parseMonteCarloArgs(['--jitter', 'x.json', '--failure-rate', '0.5'])).toThrow(
      '--jitter and --failure-rate are mutually exclusive',
    );
  });
});

describe('simMonteCarloIssues', () => {
  it('returns n specs with unique, ascending issue numbers', () => {
    const specs = simMonteCarloIssues(3);
    expect(specs).toHaveLength(3);
    expect(specs.map((s) => s.issue)).toEqual([9600, 9601, 9602]);
    expect(new Set(specs.map((s) => s.issue)).size).toBe(3);
  });
});

describe('runMonteCarloCli', () => {
  it('rejects bad input with exit 2, a message, and usage on stderr, without calling run', async () => {
    const cases = [
      ['--bogus'],
      ['--runs', 'abc'],
      ['--runs', '0'],
      ['--max-failure-rate', '1.5'],
      ['--format', 'markdown'],
      ['--jitter', 'x.json', '--failure-rate', '0.5'],
    ];
    for (const argv of cases) {
      const { deps, err, runCalls } = makeDeps();
      const code = await runMonteCarloCli(argv, deps);
      expect(code).toBe(2);
      expect(err[0]).toMatch(/^sim-monte-carlo: /);
      expect(err).toContain(MONTE_CARLO_CLI_USAGE);
      expect(runCalls).toHaveLength(0);
    }
  });

  it('--help returns 0 and writes the usage text without calling run', async () => {
    const { deps, out, runCalls } = makeDeps();
    const code = await runMonteCarloCli(['--help'], deps);
    expect(code).toBe(0);
    expect(out).toContain(MONTE_CARLO_CLI_USAGE);
    expect(runCalls).toHaveLength(0);
  });

  it('passes parsed options to the runner', async () => {
    const { deps, runCalls } = makeDeps();
    await runMonteCarloCli(['--runs', '5', '--issues', '2', '--concurrency', '3', '--max-failure-rate', '0.2'], deps);
    expect(runCalls).toHaveLength(1);
    const options = runCalls[0]!;
    expect(options.runs).toBe(5);
    expect(options.concurrency).toBe(3);
    expect(options.thresholds).toEqual({ maxFailureRate: 0.2 });
    expect(options.simulation.issues).toHaveLength(2);
    expect(options.simulation.jitter).toEqual({ seed: 1 });
  });

  it('--failure-rate populates simulation.jitter.default.failureRate', async () => {
    const { deps, runCalls } = makeDeps();
    await runMonteCarloCli(['--failure-rate', '0.4'], deps);
    expect(runCalls[0]!.simulation.jitter).toEqual({ seed: 1, default: { failureRate: 0.4 } });
  });

  it('--jitter loads a config file through the injected readFile; the file seed wins over --seed', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ seed: 99, default: { failureRate: 0.1 } }));
    const { deps, runCalls } = makeDeps({ readFile });
    await runMonteCarloCli(['--jitter', 'jitter.json', '--seed', '5'], deps);
    expect(readFile).toHaveBeenCalledWith('jitter.json');
    expect(runCalls[0]!.simulation.jitter).toEqual({ seed: 99, default: { failureRate: 0.1 } });
  });

  it('a jitter file with no seed falls back to --seed', async () => {
    const readFile = vi.fn(async () => JSON.stringify({ default: { failureRate: 0.1 } }));
    const { deps, runCalls } = makeDeps({ readFile });
    await runMonteCarloCli(['--jitter', 'jitter.json', '--seed', '5'], deps);
    expect(runCalls[0]!.simulation.jitter).toEqual({ seed: 5, default: { failureRate: 0.1 } });
  });

  it('malformed JSON in the jitter file returns 2', async () => {
    const readFile = vi.fn(async () => '{not json');
    const { deps, err } = makeDeps({ readFile });
    const code = await runMonteCarloCli(['--jitter', 'jitter.json'], deps);
    expect(code).toBe(2);
    expect(err[0]).toMatch(/^sim-monte-carlo: /);
  });

  it('a JSON array in the jitter file returns 2', async () => {
    const readFile = vi.fn(async () => '[1, 2, 3]');
    const { deps, err } = makeDeps({ readFile });
    const code = await runMonteCarloCli(['--jitter', 'jitter.json'], deps);
    expect(code).toBe(2);
    expect(err[0]).toMatch(/^sim-monte-carlo: /);
  });

  it('format table writes the table only', async () => {
    const { deps, out } = makeDeps();
    await runMonteCarloCli(['--format', 'table'], deps);
    expect(out).toHaveLength(1);
    expect(() => JSON.parse(out[0]!)).toThrow();
  });

  it('format json writes parseable JSON only', async () => {
    const { deps, out } = makeDeps();
    await runMonteCarloCli(['--format', 'json'], deps);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toMatchObject({ runs: 1 });
  });

  it('format both writes the table then the JSON', async () => {
    const { deps, out } = makeDeps();
    await runMonteCarloCli(['--format', 'both'], deps);
    expect(out).toHaveLength(2);
    expect(() => JSON.parse(out[0]!)).toThrow();
    expect(JSON.parse(out[1]!)).toMatchObject({ runs: 1 });
  });

  it('--output writes the JSON report through the injected writeFile', async () => {
    const writeFile = vi.fn(async (_path: string, _content: string) => {});
    const { deps } = makeDeps({ writeFile });
    await runMonteCarloCli(['--output', 'out.json'], deps);
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0]!;
    expect(path).toBe('out.json');
    expect(content.endsWith('\n')).toBe(true);
    expect(JSON.parse(content)).toMatchObject({ runs: 1 });
  });

  it('exit code reflects report breaches: 1 when breached, 0 when clean', async () => {
    const clean = makeDeps({ run: async () => fakeReport({ breaches: [] }) });
    expect(await runMonteCarloCli([], clean.deps)).toBe(0);

    const breached = makeDeps({
      run: async () => fakeReport({ breaches: [{ metric: 'failure', rate: 1, threshold: 0.5 }] }),
    });
    expect(await runMonteCarloCli([], breached.deps)).toBe(1);
  });

  it('a rejecting runner returns 2 and writes the message to stderr', async () => {
    const { deps, err } = makeDeps({
      run: async () => {
        throw new Error('runner exploded');
      },
    });
    const code = await runMonteCarloCli([], deps);
    expect(code).toBe(2);
    expect(err[0]).toBe('sim-monte-carlo: runner exploded');
  });

  it('AC2 end-to-end: the real runner produces a full report with no real call', { timeout: 180_000 }, async () => {
    const out: string[] = [];
    const code = await runMonteCarloCli(['--runs', '1', '--issues', '1', '--format', 'json'], {
      write: (l) => out.push(l),
    });
    expect(code).toBe(0);
    const report = JSON.parse(out[0]!) as MonteCarloReport;
    expect(report.runs).toBe(1);
    expect(report.totals.shipped).toBe(1);
    expect(report.modelCalls).toBeGreaterThan(0);
    expect(report.githubCalls).toBeGreaterThan(0);
  });
});
