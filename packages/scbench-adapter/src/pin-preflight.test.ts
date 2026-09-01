import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterError } from './checkpoint.js';
import { checkPinnedInput, parsePinFile, runPinPreflight, type PinnedInputSpec } from './pin-preflight.js';
import type { ExecFn } from './workspace.js';

const EXPECTED_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function fakeExec(script: Record<string, { exitCode: number; stdout?: string; stderr?: string }>): {
  exec: ExecFn;
  calls: { argv: string[]; cwd: string }[];
} {
  const calls: { argv: string[]; cwd: string }[] = [];
  const exec: ExecFn = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts.cwd });
    const key = argv.slice(1).join(' ');
    const scripted = script[key];
    if (!scripted) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: scripted.exitCode, stdout: scripted.stdout ?? '', stderr: scripted.stderr ?? '' };
  };
  return { exec, calls };
}

const CLEAN_SCRIPT = {
  'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
  'status --porcelain': { exitCode: 0, stdout: '' },
  'rev-parse HEAD': { exitCode: 0, stdout: `${EXPECTED_SHA}\n` },
};

describe('checkPinnedInput', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pin-preflight-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes when the checkout is clean and HEAD matches the pinned commit', async () => {
    const { exec, calls } = fakeExec(CLEAN_SCRIPT);
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result).toEqual({
      input: 'SCBENCH_CHECKOUT',
      ok: true,
      detail: `HEAD matches pinned commit ${EXPECTED_SHA}, working tree clean`,
    });
    expect(calls).toEqual([
      { argv: ['git', 'rev-parse', '--git-dir'], cwd: dir },
      { argv: ['git', 'status', '--porcelain'], cwd: dir },
      { argv: ['git', 'rev-parse', 'HEAD'], cwd: dir },
    ]);
  });

  it('fails with "is not set" when the env var is unset, without calling exec', async () => {
    const { exec, calls } = fakeExec(CLEAN_SCRIPT);
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: undefined, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result).toEqual({ input: 'SCBENCH_CHECKOUT', ok: false, detail: 'is not set' });
    expect(calls).toEqual([]);
  });

  it('fails with "is not set" when the env var is an empty string', async () => {
    const { exec } = fakeExec(CLEAN_SCRIPT);
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: '', expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result).toEqual({ input: 'SCBENCH_CHECKOUT', ok: false, detail: 'is not set' });
  });

  it('fails with "does not exist" when the path is missing, without calling exec', async () => {
    const { exec, calls } = fakeExec(CLEAN_SCRIPT);
    const missing = join(dir, 'never-created');
    const spec: PinnedInputSpec = { input: 'SCBENCH_PROBLEMS_PATH', path: missing, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.input).toBe('SCBENCH_PROBLEMS_PATH');
    expect(result.detail).toContain('does not exist');
    expect(result.detail).toContain(missing);
    expect(calls).toEqual([]);
  });

  it('fails with "not a git checkout" when rev-parse --git-dir fails', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 128, stderr: 'fatal: not a git repository' },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not a git checkout');
    expect(result.detail).toContain(dir);
  });

  it('fails with "dirty" and the change count when porcelain is non-empty (modified + untracked)', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
      'status --porcelain': { exitCode: 0, stdout: ' M src/a.ts\n?? junk.txt' },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('dirty');
    expect(result.detail).toContain('2');
  });

  it('fails as dirty when only untracked files are present', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
      'status --porcelain': { exitCode: 0, stdout: '?? junk.txt' },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('dirty');
    expect(result.detail).toContain('1');
  });

  it('fails with both actual and expected SHAs on a HEAD mismatch', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      'rev-parse HEAD': { exitCode: 0, stdout: `${OTHER_SHA}\n` },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain(OTHER_SHA);
    expect(result.detail).toContain(EXPECTED_SHA);
  });

  it('fails with "git status failed" when git status exits non-zero', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
      'status --porcelain': { exitCode: 1, stderr: 'fatal: some git error' },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('git status failed');
    expect(result.detail).toContain('some git error');
  });

  it('fails with "could not resolve HEAD" when rev-parse HEAD exits non-zero', async () => {
    const { exec } = fakeExec({
      'rev-parse --git-dir': { exitCode: 0, stdout: '.git' },
      'status --porcelain': { exitCode: 0, stdout: '' },
      'rev-parse HEAD': { exitCode: 128, stderr: 'fatal: ambiguous argument HEAD' },
    });
    const spec: PinnedInputSpec = { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA };

    const result = await checkPinnedInput(spec, { exec });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('could not resolve HEAD');
    expect(result.detail).toContain('ambiguous argument HEAD');
  });
});

describe('runPinPreflight', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pin-preflight-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok:true when every spec passes', async () => {
    const { exec } = fakeExec(CLEAN_SCRIPT);
    const specs: PinnedInputSpec[] = [
      { input: 'SCBENCH_CHECKOUT', path: dir, expectedCommit: EXPECTED_SHA },
      { input: 'SCBENCH_PROBLEMS_PATH', path: dir, expectedCommit: EXPECTED_SHA },
    ];

    const outcome = await runPinPreflight(specs, { exec });

    expect(outcome.ok).toBe(true);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results.every((r) => r.ok)).toBe(true);
  });

  it('checks every spec (no short-circuit) and aggregates ok:false with results in spec order', async () => {
    const { exec } = fakeExec(CLEAN_SCRIPT);
    const specs: PinnedInputSpec[] = [
      { input: 'SCBENCH_CHECKOUT', path: undefined, expectedCommit: EXPECTED_SHA },
      { input: 'SCBENCH_PROBLEMS_PATH', path: dir, expectedCommit: EXPECTED_SHA },
    ];

    const outcome = await runPinPreflight(specs, { exec });

    expect(outcome.ok).toBe(false);
    expect(outcome.results).toHaveLength(2);
    expect(outcome.results[0]).toEqual({ input: 'SCBENCH_CHECKOUT', ok: false, detail: 'is not set' });
    expect(outcome.results[1].ok).toBe(true);
    expect(outcome.results[1].input).toBe('SCBENCH_PROBLEMS_PATH');
  });
});

describe('parsePinFile', () => {
  it('parses the committed scbench.pin.json content shape, tolerating extra keys', () => {
    const raw = JSON.stringify({
      repo: 'https://github.com/SprocketLab/slop-code-bench',
      commit: EXPECTED_SHA,
      pinnedAt: '2026-07-28',
      problems: {
        repo: 'https://github.com/gabeorlanski/scb-problems',
        version: 'v1.0',
        commit: OTHER_SHA,
        pinnedAt: '2026-07-29',
      },
    });

    const pin = parsePinFile(raw);

    expect(pin.commit).toBe(EXPECTED_SHA);
    expect(pin.problems.commit).toBe(OTHER_SHA);
  });

  it('throws AdapterError on invalid JSON', () => {
    expect(() => parsePinFile('{not json')).toThrow(AdapterError);
    expect(() => parsePinFile('{not json')).toThrow(/not valid JSON/);
  });

  it('throws AdapterError naming the expectation when problems.commit is missing', () => {
    const raw = JSON.stringify({ commit: EXPECTED_SHA, problems: {} });

    expect(() => parsePinFile(raw)).toThrow(AdapterError);
    expect(() => parsePinFile(raw)).toThrow(/problems\.commit/);
  });

  it('throws AdapterError naming the expectation when problems.commit is a short SHA', () => {
    const raw = JSON.stringify({ commit: EXPECTED_SHA, problems: { commit: 'abc123' } });

    expect(() => parsePinFile(raw)).toThrow(AdapterError);
    expect(() => parsePinFile(raw)).toThrow(/40 hex/);
  });

  it('throws AdapterError when the top-level commit field is missing', () => {
    const raw = JSON.stringify({ problems: { commit: EXPECTED_SHA } });

    expect(() => parsePinFile(raw)).toThrow(AdapterError);
    expect(() => parsePinFile(raw)).toThrow(/missing required field "commit"/);
  });
});
