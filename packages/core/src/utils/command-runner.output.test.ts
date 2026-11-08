import { describe, expect, it } from 'vitest';

import { runCommand } from './command-runner.js';

const script = "process.stdout.write('out-line\\n'); process.stderr.write('err-line\\n'); process.exit(3)";
const argv = [process.execPath, '-e', script];

type Seen = Array<['stdout' | 'stderr', string]>;
function hook() {
  const seen: Seen = [];
  return { seen, onOutput: (s: 'stdout' | 'stderr', c: Uint8Array) => seen.push([s, Buffer.from(c).toString()]) };
}
const join = (seen: Seen, s: string) =>
  seen
    .filter(([x]) => x === s)
    .map(([, t]) => t)
    .join('');

describe('runCommand onOutput', () => {
  it('calls onOutput per chunk on the attached path with stdout/stderr identity', async () => {
    const { seen, onOutput } = hook();
    await runCommand(argv, { onOutput });
    expect(join(seen, 'stdout')).toBe('out-line\n');
    expect(join(seen, 'stderr')).toBe('err-line\n');
  });

  it('calls onOutput per chunk on the detached path', async () => {
    const { seen, onOutput } = hook();
    await runCommand(argv, { onOutput, onPgid: () => {} });
    expect(join(seen, 'stdout')).toBe('out-line\n');
    expect(join(seen, 'stderr')).toBe('err-line\n');
  });

  it('CommandResult is identical with and without onOutput', async () => {
    for (const extra of [{}, { onPgid: () => {} }]) {
      const plain = await runCommand(argv, extra);
      const tapped = await runCommand(argv, { ...extra, onOutput: () => {} });
      expect(tapped).toEqual(plain);
      expect(plain.stdout.trim()).toBe('out-line');
      expect(plain.exitCode).toBe(3);
    }
  });

  it('a throwing onOutput does not change the result', async () => {
    const throwing = () => {
      throw new Error('hook failed');
    };
    for (const extra of [{}, { onPgid: () => {} }]) {
      const plain = await runCommand(argv, extra);
      expect(await runCommand(argv, { ...extra, onOutput: throwing })).toEqual(plain);
    }
  });
});
