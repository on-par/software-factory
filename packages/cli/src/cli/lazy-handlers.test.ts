import { describe, expect, it, vi } from 'vitest';
import * as index from './index.js';
import { lazyProgramHandlers } from './lazy-handlers.js';
import * as light from './light.js';

function fakeLoad() {
  const cmdStatus = vi.fn(async (_opts?: { json?: boolean }) => {});
  const table: Partial<index.ProgramHandlers> = { cmdStatus };
  const load = vi.fn(async () => ({ PROGRAM_HANDLERS: table as index.ProgramHandlers }));
  return { load, cmdStatus };
}

describe('lazyProgramHandlers', () => {
  it('serves the light keys from light.ts without loading, and shares the CliExitError class with index.ts', () => {
    const { load } = fakeLoad();
    const handlers = lazyProgramHandlers(load);
    expect(handlers.CliExitError).toBe(light.CliExitError);
    expect(index.CliExitError).toBe(light.CliExitError);
    expect(handlers.getCliVersion).toBe(light.getCliVersion);
    expect(handlers.parseIssueArg).toBe(light.parseIssueArg);
    expect(handlers.PREREQUISITES_TEXT).toBe(light.PREREQUISITES_TEXT);
    expect(handlers.HELP_FOOTER_TEXT).toBe(light.HELP_FOOTER_TEXT);
    expect(load).not.toHaveBeenCalled();
  });

  it('does not load until a command handler is invoked, then forwards args and the result', async () => {
    const { load, cmdStatus } = fakeLoad();
    const handlers = lazyProgramHandlers(load);
    const forwarder = handlers.cmdStatus;
    expect(load).not.toHaveBeenCalled();
    await expect(forwarder({ json: true })).resolves.toBeUndefined();
    expect(cmdStatus).toHaveBeenCalledWith({ json: true });
  });

  it('loads once across invocations', async () => {
    const { load } = fakeLoad();
    const handlers = lazyProgramHandlers(load);
    await handlers.cmdStatus({});
    await handlers.cmdStatus({});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects when the loaded table has no such handler', async () => {
    const handlers = lazyProgramHandlers(async () => ({ PROGRAM_HANDLERS: {} as index.ProgramHandlers }));
    await expect(handlers.cmdStatus({})).rejects.toThrow("unknown command handler 'cmdStatus'");
  });
});
