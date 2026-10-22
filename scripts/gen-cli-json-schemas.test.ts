import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { runGenCliJsonSchemas } from './gen-cli-json-schemas.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GENERATOR = join(ROOT, 'scripts', 'gen-cli-json-schemas.ts');
const GUARD = join(ROOT, 'scripts', 'check-cli-json-schemas.sh');
const COMMITTED = join(ROOT, 'packages', 'cli', 'schemas');
const tempDirs = createTempDirs();
const expectedFiles = [
  'queue-add.schema.json',
  'cost.schema.json',
  'daemon-status.schema.json',
  'logs-line.schema.json',
  'queue-list.schema.json',
  'runs-diffstat.schema.json',
  'runs.schema.json',
  'resume.schema.json',
  'status.schema.json',
  'stop.schema.json',
  'unpark-batch.schema.json',
  'unpark.schema.json',
  'usage.schema.json',
].sort();

afterEach(async () => {
  await tempDirs.cleanup();
});

/** The real `node --import tsx` entry point; one smoke run, every other case runs in-process. */
function runGeneratorCli(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', GENERATOR, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

async function generate(...args: string[]) {
  const errors: string[] = [];
  const status = await runGenCliJsonSchemas(args, (text) => void errors.push(text));
  return { status, errors };
}

function runGuard(...args: string[]) {
  return spawnSync('bash', [GUARD, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function copySchemas(destination: string): void {
  cpSync(COMMITTED, destination, { recursive: true });
}

describe('CLI JSON Schema generator', () => {
  it('writes exactly the twelve schema artifacts deterministically, in-process and through the CLI', async () => {
    const cli = tempDirs.makeSync('cli-schemas-cli-');
    const inProcess = tempDirs.makeSync('cli-schemas-in-process-');
    expect(runGeneratorCli(cli).status).toBe(0);
    expect((await generate(inProcess)).status).toBe(0);
    expect(readdirSync(inProcess).sort()).toEqual(expectedFiles);
    expect(readdirSync(cli).sort()).toEqual(expectedFiles);
    for (const filename of expectedFiles) {
      expect(readFileSync(join(inProcess, filename), 'utf8')).toBe(readFileSync(join(cli, filename), 'utf8'));
    }
  });

  it('rejects missing, empty, surplus, and unwritable output arguments', async () => {
    for (const args of [[], [''], ['unused', 'extra']]) {
      const { status, errors } = await generate(...args);
      expect(status).toBe(2);
      expect(errors).toEqual(['usage: tsx scripts/gen-cli-json-schemas.ts <output-directory>\n']);
    }
    const filePath = join(tempDirs.makeSync('cli-schemas-file-'), 'file');
    writeFileSync(filePath, 'file');
    await expect(generate(filePath)).rejects.toThrow();
  });

  it('passes when the reference directory matches generated output', () => {
    const reference = tempDirs.makeSync('cli-schemas-reference-');
    copySchemas(reference);
    const result = runGuard(reference);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-cli-json-schemas: OK');
  });

  it('names a modified, a missing and an obsolete reference schema and exits nonzero without rewriting them', () => {
    const reference = tempDirs.makeSync('cli-schemas-drift-');
    copySchemas(reference);
    const statusPath = join(reference, 'status.schema.json');
    writeFileSync(statusPath, `${readFileSync(statusPath, 'utf8')} `);
    const changedText = readFileSync(statusPath, 'utf8');
    rmSync(join(reference, 'usage.schema.json'));
    writeFileSync(join(reference, 'old.schema.json'), '{}\n');
    const result = runGuard(reference);
    expect(result.status).not.toBe(0);
    for (const filename of ['status.schema.json', 'usage.schema.json', 'old.schema.json']) {
      expect(`${result.stdout}${result.stderr}`).toContain(filename);
    }
    expect(readFileSync(statusPath, 'utf8')).toBe(changedText);
  });

  it('rejects empty, nonexistent, and surplus guard arguments', () => {
    expect(runGuard('').status).not.toBe(0);
    expect(runGuard('/path/that/does/not/exist').status).not.toBe(0);
    expect(runGuard('/tmp/reference', 'extra').status).not.toBe(0);
  });
});
