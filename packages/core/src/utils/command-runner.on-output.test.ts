import { describe, expect, it } from 'vitest';

import { runCommand } from './command-runner.js';

const script = `process.stdout.write('out\\n'); process.stderr.write('err\\n');`;
const argv = [process.execPath, '-e', script];

function gather(extra: { onPgid?: (p: number) => void } = {}) {
  const seen: Array<[string, string]> = [];
  const opts = { ...extra, onOutput: (s: 'stdout' | 'stderr', c: Buffer) => seen.push([s, c.toString()]) };
  return { seen, opts };
}

describe('runCommand onOutput (#3994)', () => {
  it('calls onOutput per chunk with stream identity on the attached path', async () => {
    const { seen, opts } = gather();
    const r = await runCommand(argv, opts);
    expect(r.ok).toBe(true);
    expect(seen).toContainEqual(['stdout', 'out\n']);
    expect(seen).toContainEqual(['stderr', 'err\n']);
  });

  it('calls onOutput per chunk with stream identity on the detached path', async () => {
    const { seen, opts } = gather({ onPgid: () => {} });
    const r = await runCommand(argv, opts);
    expect(r.ok).toBe(true);
    expect(seen).toContainEqual(['stdout', 'out\n']);
    expect(seen).toContainEqual(['stderr', 'err\n']);
  });

  it('an onOutput that throws does not change the CommandResult', async () => {
    for (const onPgid of [undefined, () => {}]) {
      const plain = await runCommand(argv, { onPgid });
      const r = await runCommand(argv, {
        onPgid,
        onOutput: () => {
          throw new Error('boom');
        },
      });
      expect(r).toEqual(plain);
    }
  });
});
