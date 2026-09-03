import { describe, expect, it, vi } from 'vitest';

import {
  buildSuiteLauncherArgv,
  renderSuiteSummary,
  runSuite,
  summarizeSuite,
  LAUNCHER_CONFIG_ARG,
  LAUNCHER_SCRIPT,
  type SuiteProblemRecord,
} from './suite.js';
import type { ExecFn } from './workspace.js';

describe('buildSuiteLauncherArgv', () => {
  it('builds the exact pinned launcher command as argv', () => {
    expect(buildSuiteLauncherArgv('/opt/scbench', 'cfgpipe')).toEqual([
      'uv',
      'run',
      '--project',
      '/opt/scbench',
      'python',
      LAUNCHER_SCRIPT,
      'run',
      '--config',
      LAUNCHER_CONFIG_ARG,
      '--problem',
      'cfgpipe',
    ]);
  });

  it('appends --provider-api-key-env <var> at the end when a provider api key env var is given', () => {
    expect(buildSuiteLauncherArgv('/opt/scbench', 'cfgpipe', 'SCBENCH_PLACEHOLDER_KEY')).toEqual([
      ...buildSuiteLauncherArgv('/opt/scbench', 'cfgpipe'),
      '--provider-api-key-env',
      'SCBENCH_PLACEHOLDER_KEY',
    ]);
  });

  it('leaves the argv unchanged for an empty provider api key env var', () => {
    expect(buildSuiteLauncherArgv('/opt/scbench', 'cfgpipe', '')).toEqual(
      buildSuiteLauncherArgv('/opt/scbench', 'cfgpipe'),
    );
  });
});

describe('runSuite', () => {
  function recordingExec(exitCodes: Record<string, number>): { exec: ExecFn; calls: Parameters<ExecFn>[] } {
    const calls: Parameters<ExecFn>[] = [];
    const exec: ExecFn = async (argv, opts) => {
      calls.push([argv, opts]);
      const problemId = argv[argv.length - 1];
      return { exitCode: exitCodes[problemId] ?? 0, stdout: '', stderr: '' };
    };
    return { exec, calls };
  }

  it('runs one launcher invocation per problem with the repo cwd and VIRTUAL_ENV stripped', async () => {
    const { exec, calls } = recordingExec({});
    const log = vi.fn();

    const records = await runSuite(
      { checkout: '/opt/scbench', problemIds: ['alpha', 'beta'], cwd: '/repo' },
      { exec, log },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual(buildSuiteLauncherArgv('/opt/scbench', 'alpha'));
    expect(calls[1][0]).toEqual(buildSuiteLauncherArgv('/opt/scbench', 'beta'));
    for (const [, opts] of calls) {
      expect(opts).toEqual({ cwd: '/repo', env: { VIRTUAL_ENV: undefined } });
    }
    expect(records).toEqual([
      { problemId: 'alpha', exitCode: 0 },
      { problemId: 'beta', exitCode: 0 },
    ]);
    expect(log).toHaveBeenCalledWith('suite: running alpha');
    expect(log).toHaveBeenCalledWith('suite: alpha exited 0');
  });

  it('threads providerApiKeyEnv into every launcher argv when set', async () => {
    const { exec, calls } = recordingExec({});
    const log = vi.fn();

    await runSuite(
      { checkout: '/opt/scbench', problemIds: ['alpha', 'beta'], cwd: '/repo', providerApiKeyEnv: 'PLACEHOLDER_KEY' },
      { exec, log },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toEqual(buildSuiteLauncherArgv('/opt/scbench', 'alpha', 'PLACEHOLDER_KEY'));
    expect(calls[1][0]).toEqual(buildSuiteLauncherArgv('/opt/scbench', 'beta', 'PLACEHOLDER_KEY'));
  });

  it('continues past a failed problem, recording its non-zero exit', async () => {
    const { exec, calls } = recordingExec({ beta: 3 });
    const log = vi.fn();

    const records = await runSuite(
      { checkout: '/opt/scbench', problemIds: ['alpha', 'beta', 'gamma'], cwd: '/repo' },
      { exec, log },
    );

    expect(calls).toHaveLength(3);
    expect(records).toEqual([
      { problemId: 'alpha', exitCode: 0 },
      { problemId: 'beta', exitCode: 3 },
      { problemId: 'gamma', exitCode: 0 },
    ]);
    expect(log).toHaveBeenCalledWith('suite: beta exited 3 — continuing');
  });

  it('continues past a thrown exec, yielding no record for the crashed problem', async () => {
    const calls: string[] = [];
    const exec: ExecFn = async (argv) => {
      const problemId = argv[argv.length - 1];
      calls.push(problemId);
      if (problemId === 'beta') throw new Error('spawn ENOMEM');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const log = vi.fn();

    const records = await runSuite(
      { checkout: '/opt/scbench', problemIds: ['alpha', 'beta', 'gamma'], cwd: '/repo' },
      { exec, log },
    );

    expect(calls).toEqual(['alpha', 'beta', 'gamma']);
    expect(records).toEqual([
      { problemId: 'alpha', exitCode: 0 },
      { problemId: 'gamma', exitCode: 0 },
    ]);
    expect(log).toHaveBeenCalledWith('suite: beta crashed: spawn ENOMEM — continuing');
  });
});

describe('summarizeSuite', () => {
  it('classifies every configured problem as exactly one of completed, failed, or missing', () => {
    const records: SuiteProblemRecord[] = [
      { problemId: 'alpha', exitCode: 0 },
      { problemId: 'beta', exitCode: 2 },
    ];

    expect(summarizeSuite(['alpha', 'beta', 'gamma'], records)).toEqual({
      completed: ['alpha'],
      failed: ['beta'],
      missing: ['gamma'],
    });
  });

  it('preserves configured order within each class', () => {
    const records: SuiteProblemRecord[] = [
      { problemId: 'gamma', exitCode: 0 },
      { problemId: 'alpha', exitCode: 0 },
    ];

    expect(summarizeSuite(['alpha', 'beta', 'gamma'], records).completed).toEqual(['alpha', 'gamma']);
  });

  it('ignores records for unconfigured problem ids', () => {
    const records: SuiteProblemRecord[] = [{ problemId: 'rogue', exitCode: 0 }];

    expect(summarizeSuite(['alpha'], records)).toEqual({ completed: [], failed: [], missing: ['alpha'] });
  });
});

describe('renderSuiteSummary', () => {
  it('renders one line per class', () => {
    const rendered = renderSuiteSummary({ completed: ['alpha', 'beta'], failed: ['gamma'], missing: [] });

    expect(rendered).toBe(
      'suite summary: completed — alpha, beta\nsuite summary: failed — gamma\nsuite summary: missing — (none)',
    );
  });

  it('renders (none) for every empty class', () => {
    const rendered = renderSuiteSummary({ completed: [], failed: [], missing: [] });

    expect(rendered).toBe(
      'suite summary: completed — (none)\nsuite summary: failed — (none)\nsuite summary: missing — (none)',
    );
  });
});
