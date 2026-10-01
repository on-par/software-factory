import { Command } from 'commander';
import { branchFor } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
import { addBranchPrefixOption, resolveBranchPrefixOption } from './branch-prefix.js';

describe('resolveBranchPrefixOption', () => {
  it('defaults to factory when the flag is omitted', () => {
    const prefix = resolveBranchPrefixOption(undefined);
    expect(prefix).toBe('factory');
    expect(branchFor(42, 'Add a flag', prefix as string)).toBe('factory/42-add-a-flag');
  });

  it('uses the override in the branch name', () => {
    const prefix = resolveBranchPrefixOption('sf');
    expect(prefix).toBe('sf');
    expect(branchFor(42, 'Add a flag', prefix as string)).toBe('sf/42-add-a-flag');
  });

  it('normalizes the value', () => {
    expect(resolveBranchPrefixOption('SF')).toBe('sf');
  });

  it('rejects values without letters or digits', () => {
    expect(resolveBranchPrefixOption('')).toBeNull();
    expect(resolveBranchPrefixOption('!!!')).toBeNull();
  });
});

describe('addBranchPrefixOption', () => {
  it('parses --branch-prefix', () => {
    const cmd = addBranchPrefixOption(new Command('x'));
    cmd.parse(['--branch-prefix', 'sf'], { from: 'user' });
    expect(cmd.opts().branchPrefix).toBe('sf');
  });

  it('leaves the option undefined when omitted', () => {
    const cmd = addBranchPrefixOption(new Command('x'));
    cmd.parse([], { from: 'user' });
    expect(cmd.opts().branchPrefix).toBeUndefined();
  });
});
