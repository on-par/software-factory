import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const script = readFileSync(new URL('./verify.sh', import.meta.url), 'utf8');
const lines = script.split('\n');
const noCoverageIf = /^\s*if \[ "\$NO_COVERAGE"/;

describe('scripts/verify.sh', () => {
  it('runs the coverage-enforcing test command in --no-coverage mode', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toContain('vitest run --coverage');
    expect(script).not.toMatch(/npx vitest run/);

    const testLine = lines.findIndex((line) => line.includes('npm run test -- --maxWorkers'));
    expect(testLine).toBeGreaterThanOrEqual(0);
    const before = lines.slice(0, testLine);
    const opened = before.filter((line) => noCoverageIf.test(line)).length;
    const closed = before.filter(
      (line, i) => /^fi\b/.test(line) && lines.slice(0, i).some((l) => noCoverageIf.test(l)),
    ).length;
    expect(opened - closed).toBe(0);
    expect(lines[testLine]).toMatch(/^npm run test/);
  });

  it('runs coverage-ratchet only on the full path, never with --no-coverage or --no-e2e', () => {
    const code = lines.filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(code.match(/coverage-ratchet/g)).toHaveLength(1);
    const start = lines.findIndex((line) => line.trim() === 'if [ "$NO_COVERAGE" != "1" ]; then');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && /^fi\b/.test(line));
    expect(lines.slice(start, end).join('\n')).toContain('npm run coverage-ratchet');
    expect(script).toContain('--no-coverage) NO_COVERAGE=1');
    const e2eCase = script.slice(script.indexOf('--no-e2e)'));
    expect(e2eCase.slice(0, e2eCase.indexOf(';;'))).toContain('NO_COVERAGE=1');
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function runWithStubs(flag: string) {
    const bin = mkdtempSync(join(tmpdir(), 'verify-stubs-'));
    dirs.push(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 78\n');
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'npm'), 0o755);
    const verifyPath = fileURLToPath(new URL('./verify.sh', import.meta.url));
    return spawnSync('bash', [verifyPath, flag], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });
  }

  it('prints a deprecation note for --no-e2e and none for --no-coverage', () => {
    const legacy = runWithStubs('--no-e2e');
    expect(legacy.status).toBe(78);
    expect(legacy.stderr).toContain('verify: --no-e2e is deprecated; use --no-coverage');
    const current = runWithStubs('--no-coverage');
    expect(current.status).toBe(78);
    expect(current.stdout + current.stderr).not.toContain('deprecated');
  });
});
