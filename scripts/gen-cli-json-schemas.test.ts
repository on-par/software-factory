import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

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
  'unpark.schema.json',
  'usage.schema.json',
].sort();

afterEach(async () => {
  await tempDirs.cleanup();
});

function runGenerator(...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', GENERATOR, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function runGuard(...args: string[]) {
  return spawnSync('bash', [GUARD, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function copySchemas(destination: string): void {
  cpSync(COMMITTED, destination, { recursive: true });
}

describe('CLI JSON Schema generator', () => {
  it('writes exactly the twelve schema artifacts deterministically', () => {
    const first = tempDirs.makeSync('cli-schemas-first-');
    const second = tempDirs.makeSync('cli-schemas-second-');
    expect(runGenerator(first).status).toBe(0);
    expect(runGenerator(second).status).toBe(0);
    expect(readdirSync(first).sort()).toEqual(expectedFiles);
    for (const filename of expectedFiles) {
      expect(readFileSync(join(first, filename), 'utf8')).toBe(readFileSync(join(second, filename), 'utf8'));
    }
  });

  it('rejects missing, empty, surplus, and unwritable output arguments', () => {
    expect(runGenerator().status).not.toBe(0);
    expect(runGenerator('').status).not.toBe(0);
    expect(runGenerator('/tmp/unused', 'extra').status).not.toBe(0);
    const filePath = join(tempDirs.makeSync('cli-schemas-file-'), 'file');
    writeFileSync(filePath, 'file');
    expect(runGenerator(filePath).status).not.toBe(0);
  });

  it('passes when the reference directory matches generated output', () => {
    const reference = tempDirs.makeSync('cli-schemas-reference-');
    copySchemas(reference);
    const result = runGuard(reference);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('check-cli-json-schemas: OK');
  });

  it('names a modified status schema and exits nonzero without rewriting it', () => {
    const reference = tempDirs.makeSync('cli-schemas-modified-');
    copySchemas(reference);
    const statusPath = join(reference, 'status.schema.json');
    writeFileSync(statusPath, `${readFileSync(statusPath, 'utf8')} `);
    const changedText = readFileSync(statusPath, 'utf8');
    const result = runGuard(reference);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('status.schema.json');
    expect(readFileSync(statusPath, 'utf8')).toBe(changedText);
  });

  it('names missing and obsolete reference schemas', () => {
    const missing = tempDirs.makeSync('cli-schemas-missing-');
    copySchemas(missing);
    const deletedFilename = 'usage.schema.json';
    rmSync(join(missing, deletedFilename));
    const missingResult = runGuard(missing);
    expect(missingResult.status).not.toBe(0);
    expect(`${missingResult.stdout}${missingResult.stderr}`).toContain(deletedFilename);

    const obsolete = tempDirs.makeSync('cli-schemas-obsolete-');
    copySchemas(obsolete);
    const obsoleteFilename = 'old.schema.json';
    writeFileSync(join(obsolete, obsoleteFilename), '{}\n');
    const obsoleteResult = runGuard(obsolete);
    expect(obsoleteResult.status).not.toBe(0);
    expect(`${obsoleteResult.stdout}${obsoleteResult.stderr}`).toContain(obsoleteFilename);
  });

  it('rejects empty, nonexistent, and surplus guard arguments', () => {
    expect(runGuard('').status).not.toBe(0);
    expect(runGuard('/path/that/does/not/exist').status).not.toBe(0);
    expect(runGuard('/tmp/reference', 'extra').status).not.toBe(0);
  });
});
