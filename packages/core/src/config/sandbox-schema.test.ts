import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDirs } from '../harness/temp-dir.js';

import { loadFactoryConfig, loadFactoryConfigForRepo } from './index.js';
import { codexSandboxValueIssue, SandboxConfigSchema } from './sandbox-schema.js';

const tempDirs = createTempDirs();

describe('sandbox.writablePaths config (#3454)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDirs.make('factory-sandbox-schema-');
  });

  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it('loadFactoryConfigForRepo rejects an invalid sandbox.writablePaths entry', async () => {
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ sandbox: { writablePaths: ['relative/dir'] } }));
    expect(() => loadFactoryConfigForRepo(path)).toThrow(/sandbox\.writablePaths.*relative\/dir/);
  });

  it('keeps a valid sandbox.writablePaths entry and defaults to []', async () => {
    expect(loadFactoryConfig().sandbox.writablePaths).toEqual([]);
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ sandbox: { writablePaths: ['~/.nuget'] } }));
    expect(loadFactoryConfigForRepo(path).sandbox.writablePaths).toEqual(['~/.nuget']);
  });
});

describe('sandbox.codexSandbox config (#3829)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDirs.make('factory-codex-sandbox-');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tempDirs.cleanup();
  });

  it('SandboxConfigSchema accepts codexSandbox and gives it no default (#3829)', () => {
    expect(SandboxConfigSchema.parse({ codexSandbox: 'workspace-write' }).codexSandbox).toBe('workspace-write');
    expect('codexSandbox' in SandboxConfigSchema.parse({})).toBe(false);
    expect('codexSandbox' in SandboxConfigSchema.parse(undefined)).toBe(false);
    expect(loadFactoryConfig().sandbox.codexSandbox).toBeUndefined();
  });

  it('keeps a valid sandbox.codexSandbox value on the loaded config (#3829)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const value of ['danger-full-access', 'workspace-write'] as const) {
      const path = join(dir, `${value}.json`);
      await writeFile(path, JSON.stringify({ sandbox: { codexSandbox: value } }));
      expect(loadFactoryConfigForRepo(path).sandbox.codexSandbox).toBe(value);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once and drops an unknown sandbox.codexSandbox value (#3829)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const path = join(dir, 'config.json');
    await writeFile(path, JSON.stringify({ sandbox: { codexSandbox: 'read-only' } }));
    expect(loadFactoryConfigForRepo(path).sandbox.codexSandbox).toBeUndefined();
    expect(loadFactoryConfigForRepo(path).sandbox.codexSandbox).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    for (const part of ['sandbox.codexSandbox', 'read-only', 'danger-full-access', 'workspace-write']) {
      expect(message).toContain(part);
    }
  });

  it('warns and drops a non-string or empty value (#3829)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const [i, value] of [5, ''].entries()) {
      const path = join(dir, `bad-${i}.json`);
      await writeFile(path, JSON.stringify({ sandbox: { codexSandbox: value } }));
      expect(loadFactoryConfigForRepo(path).sandbox.codexSandbox).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('codexSandboxValueIssue reports only an unknown present value', () => {
    expect(codexSandboxValueIssue({})).toBeUndefined();
    expect(codexSandboxValueIssue({ sandbox: 'x' })).toBeUndefined();
    expect(codexSandboxValueIssue({ sandbox: {} })).toBeUndefined();
    expect(codexSandboxValueIssue({ sandbox: { codexSandbox: 'workspace-write' } })).toBeUndefined();
    const issue = codexSandboxValueIssue({ sandbox: { codexSandbox: 'read-only' } });
    expect(issue?.value).toBe('read-only');
    expect(issue?.message).toContain('"read-only"');
    expect(issue?.message).toContain('later release');
    expect(issue?.fix).toContain('docs/config.example.yaml');
  });
});
