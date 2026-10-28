import { Command } from 'commander';
import { branchFor } from '@on-par/factory-core/internal';
import { describe, expect, it } from 'vitest';
import {
  BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION,
  addBranchPrefixOption,
  resolveBranchPrefixOption,
} from './branch-prefix.js';
import { workKeyFromIssue } from '@on-par/factory-core';

describe('resolveBranchPrefixOption', () => {
  it('defaults to factory when the flag is omitted', () => {
    const prefix = resolveBranchPrefixOption(undefined);
    expect(prefix).toBe('factory');
    expect(branchFor(workKeyFromIssue(42), 'Add a flag', prefix as string)).toBe('factory/42-add-a-flag');
  });

  it('uses the override in the branch name', () => {
    const prefix = resolveBranchPrefixOption('sf');
    expect(prefix).toBe('sf');
    expect(branchFor(workKeyFromIssue(42), 'Add a flag', prefix as string)).toBe('sf/42-add-a-flag');
  });

  it('normalizes the value', () => {
    expect(resolveBranchPrefixOption('SF')).toBe('sf');
  });

  it('rejects values without letters or digits', () => {
    expect(resolveBranchPrefixOption('')).toBeNull();
    expect(resolveBranchPrefixOption('!!!')).toBeNull();
  });

  it('uses run.branchPrefix from config when the flag is omitted', () => {
    expect(resolveBranchPrefixOption(undefined, { run: { branchPrefix: 'Acme Bots' } })).toBe('acme-bots');
  });

  it('lets the flag beat run.branchPrefix', () => {
    expect(resolveBranchPrefixOption('sf', { run: { branchPrefix: 'acme' } })).toBe('sf');
    expect(resolveBranchPrefixOption('!!!', { run: { branchPrefix: 'acme' } })).toBeNull();
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

describe('BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION', () => {
  it('tells the user legacy ship-it/ branches are included', () => {
    expect(BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION).toContain('ship-it/');
    expect(BRANCH_PREFIX_MATCH_OPTION_DESCRIPTION).toBe(
      'Branch-name prefix of factory branches to act on; legacy ship-it/ branches are always included (default: run.branchPrefix, else factory)',
    );
  });
});
