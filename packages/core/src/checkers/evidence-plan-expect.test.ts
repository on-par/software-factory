import { describe, expect, it } from 'vitest';
import { CommandEvidenceSchema } from '@on-par/contracts';
import type { CommandResult } from '../utils/command-runner.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { runEvidencePlan } from './evidence-plan.js';

const policy: SandboxPolicy = {
  runtime: 'firejail',
  worktree: '/tmp/lane',
  writablePaths: ['/tmp/lane'],
  writableFilePrefixes: [],
  allowHosts: [],
  cpuMs: 100,
  memMb: 256,
};
const command = (expectation?: { exitCode?: number; stdoutContains?: string[] }, cmd = 'check') =>
  CommandEvidenceSchema.parse({
    kind: 'command',
    claim: 'the widget reports ready',
    command: cmd,
    passWhen: 'the widget is ready',
    ...(expectation === undefined ? {} : { expect: expectation }),
  });
const outcome = (exitCode: number, stdout = '', stderr = ''): CommandResult => ({
  command: [],
  stdout,
  stderr,
  exitCode,
  killed: false,
  timedOut: false,
  ok: exitCode === 0,
});
const run = (entry: ReturnType<typeof command>, result: CommandResult) =>
  runEvidencePlan([entry], new Map([['check', ['echo', 'checked']]]), {
    worktree: '/tmp/lane',
    sandbox: policy,
    runCommand: async () => result,
  });

describe('command evidence expectations', () => {
  it('command expect.stdoutContains match PASSes and records match', async () => {
    const result = await run(
      command({ stdoutContains: ['WIDGET_OK', 'READY'] }),
      outcome(0, `WIDGET_OK READY${'y'.repeat(2100)}`),
    );
    expect(result[0]).toMatchObject({
      claim: 'the widget reports ready',
      status: 'PASS',
      reason: 'expected exit 0; matched stdout requirements ["WIDGET_OK","READY"]',
    });
    expect(result[0]?.outputTail).not.toContain('WIDGET_OK');
    expect((await run(command({ stdoutContains: [] }), outcome(0)))[0]?.status).toBe('PASS');
  });

  it('command expect.stdoutContains miss FAILs with bounded expected and actual diagnostics', async () => {
    const result = await run(command({ stdoutContains: ['WIDGET_OK'] }), outcome(0, 'nope'));
    expect(result[0]).toMatchObject({ claim: 'the widget reports ready', status: 'FAIL' });
    expect(result[0]?.reason).toContain('WIDGET_OK');
    expect(result[0]?.reason).toContain('actual stdout: nope');
    expect(result[0]?.reason.length).toBeLessThanOrEqual(2000);
    expect((await run(command({ stdoutContains: ['ok', 'missing'] }), outcome(0, 'ok')))[0]?.reason).toContain(
      '["missing"]',
    );
    for (const [stdout, stderr] of [
      ['widget_ok', ''],
      ['', 'WIDGET_OK'],
      ['', ''],
    ] as const) {
      const miss = (await run(command({ stdoutContains: ['WIDGET_OK'] }), outcome(0, stdout, stderr)))[0];
      expect(miss?.status).toBe('FAIL');
      if (!stdout) expect(miss?.reason).toContain('<empty>');
      if (stderr) expect(miss?.reason).toContain('actual stderr: WIDGET_OK');
    }
    const capped = await run(command({ stdoutContains: ['WIDGET_OK'] }), outcome(0, 'z'.repeat(2500)));
    expect(capped[0]?.outputTail).toHaveLength(2000);
    expect(capped[0]?.reason.length).toBeLessThanOrEqual(2000);
  });

  it('prose-only passWhen PASSes with not-machine-checked flag', async () => {
    const passed = await run(command(), outcome(0));
    expect(passed[0]).toMatchObject({ status: 'PASS', passWhenNotMachineChecked: true });
    expect(passed[0]?.reason).toContain('passWhen not machine-checked');
    const failed = await run(command(), outcome(1));
    expect(failed[0]).toMatchObject({ status: 'FAIL', passWhenNotMachineChecked: true });
    expect(failed[0]?.reason).toContain('passWhen not machine-checked');
  });

  it('matches explicit exit codes and defaults omitted or empty expectations to zero', async () => {
    expect((await run(command({ exitCode: 2 }), outcome(2)))[0]?.status).toBe('PASS');
    expect((await run(command({ exitCode: 2 }), outcome(0)))[0]).toMatchObject({ status: 'FAIL' });
    expect((await run(command({}), outcome(0)))[0]?.status).toBe('PASS');
    const wrong = (await run(command({ exitCode: 2 }), outcome(0)))[0];
    expect(wrong?.reason).toContain('expected exit 2, actual exit 0');
  });

  it('timeout, termination, and execution errors fail despite matching expectations', async () => {
    for (const change of [{ timedOut: true }, { killed: true }]) {
      const result = await run(command({ stdoutContains: ['READY'] }), { ...outcome(0, 'READY'), ...change });
      expect(result[0]?.status).toBe('FAIL');
    }
    const result = await runEvidencePlan([command({ stdoutContains: ['READY'] })], new Map([['check', ['echo']]]), {
      worktree: '/tmp/lane',
      sandbox: policy,
      runCommand: async () => {
        throw new Error('failed');
      },
    });
    expect(result[0]?.status).toBe('FAIL');
  });

  it('keeps allowlist and sandbox gates ahead of command execution', async () => {
    let calls = 0;
    const disallowed = await runEvidencePlan([command({ stdoutContains: ['READY'] }, 'unknown')], new Map(), {
      worktree: '/tmp/lane',
      sandbox: policy,
      runCommand: async () => {
        calls++;
        return outcome(0, 'READY');
      },
    });
    const unavailable = await runEvidencePlan(
      [command({ stdoutContains: ['READY'] })],
      new Map([['check', ['echo']]]),
      {
        worktree: '/tmp/lane',
        runCommand: async () => {
          calls++;
          return outcome(0, 'READY');
        },
      },
    );
    expect(disallowed[0]).toMatchObject({ status: 'SKIP', reason: 'not allowlisted' });
    expect(unavailable[0]).toMatchObject({ status: 'SKIP', reason: 'sandbox unavailable' });
    expect(calls).toBe(0);
  });
});
