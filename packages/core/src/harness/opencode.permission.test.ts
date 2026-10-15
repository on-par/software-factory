import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { makeContractRequest } from './contract.js';
import { HarnessError, isRetryableFailure } from './index.js';
import { OpenCodeHarness } from './opencode.js';

const permissionFixture = readFileSync(
  fileURLToPath(new URL('../__fixtures__/opencode/permission-auto-rejected.jsonl', import.meta.url)),
  'utf8',
);

function recordingExec(result: { stdout?: string; stderr?: string } = {}) {
  const calls: { cmd: string }[] = [];
  const fn = async (cmd: string) => {
    if (cmd === 'opencode --version') return { stdout: '', stderr: '' };
    calls.push({ cmd });
    return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
  return { fn, calls };
}

describe('OpenCodeHarness permission auto-rejection', () => {
  const run = (rec: ReturnType<typeof recordingExec>) => new OpenCodeHarness(rec.fn as any).run(makeContractRequest());

  it('rejects the recorded permission-auto-rejected fixture as permission_denied naming bash', async () => {
    const err = await run(recordingExec({ stdout: permissionFixture })).catch((e) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect(err.reason).toBe('permission_denied');
    expect(err.message).toContain('bash');
    expect(err.details.exitCode).toBe(0);
  });

  it('runs opencode once and permission_denied is not retryable', async () => {
    const rec = recordingExec({ stdout: permissionFixture });
    await expect(run(rec)).rejects.toMatchObject({ reason: 'permission_denied' });
    expect(rec.calls).toHaveLength(1);
    expect(isRetryableFailure('permission_denied')).toBe(false);
  });

  it('returns the final text when a tool_use error does not mention permission', async () => {
    const stdout = [
      JSON.stringify({
        type: 'tool_use',
        part: { tool: 'read', state: { status: 'error', error: 'ENOENT: no such file' } },
      }),
      JSON.stringify({ type: 'text', part: { text: 'done' } }),
    ].join('\n');
    const rec = recordingExec({ stdout });
    const result = await run(rec);
    expect(result.output).toBe('done');
    expect(rec.calls).toHaveLength(1);
  });
});
