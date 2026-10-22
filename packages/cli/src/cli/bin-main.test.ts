import { afterEach, describe, expect, it, vi } from 'vitest';
import { binMain } from './bin-main.js';
import { formatOverview } from './light.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('binMain', () => {
  it('prints the overview for no args', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await binMain(['node', 'factory']);
    expect(log).toHaveBeenCalledWith(formatOverview());
  });

  it('prints the version through commander without loading the engine', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as typeof process.exit);
    await expect(binMain(['node', 'factory', '--version'])).rejects.toThrow('exit');
    expect(write).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('maps a CliExitError from a handler to process.exitCode', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // ship validates the issue argument with the light parseIssueArg before the engine loads
    await binMain(['node', 'factory', 'ship', 'abc']);
    expect(error).toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
