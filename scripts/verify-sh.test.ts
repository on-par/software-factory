import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const script = readFileSync(new URL('./verify.sh', import.meta.url), 'utf8');
const lines = script.split('\n');
const noE2eIf = /^\s*if \[ "\$NO_E2E"/;

describe('scripts/verify.sh', () => {
  it('runs the coverage-enforcing test command in --no-e2e mode', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.test).toContain('vitest run --coverage');
    expect(script).not.toMatch(/npx vitest run/);

    const testLine = lines.findIndex((line) => line.includes('npm run test -- --maxWorkers'));
    expect(testLine).toBeGreaterThanOrEqual(0);
    const before = lines.slice(0, testLine);
    const opened = before.filter((line) => noE2eIf.test(line)).length;
    const closed = before.filter(
      (line, i) => /^fi\b/.test(line) && lines.slice(0, i).some((l) => noE2eIf.test(l)),
    ).length;
    expect(opened - closed).toBe(0);
    expect(lines[testLine]).toMatch(/^npm run test/);
  });

  it('runs coverage-ratchet only on the full path, never with --no-e2e', () => {
    const code = lines.filter((line) => !line.trimStart().startsWith('#')).join('\n');
    expect(code.match(/coverage-ratchet/g)).toHaveLength(1);
    const start = lines.findIndex((line) => line.trim() === 'if [ "$NO_E2E" != "1" ]; then');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && /^fi\b/.test(line));
    expect(lines.slice(start, end).join('\n')).toContain('npm run coverage-ratchet');
  });
});
