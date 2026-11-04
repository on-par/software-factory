// packages/cli/src/cli/ship-options.test.ts — --base-branch validation and conflict rules (#3764)
import { describe, expect, it } from 'vitest';

import { CliExitError } from './errors.js';
import {
  baseBranchConflict,
  baseBranchOrExit,
  baseRemoteRef,
  inPlaceConflict,
  parseBaseBranch,
  resolveWorkspaceMode,
} from './ship-options.js';

describe('parseBaseBranch', () => {
  it.each(['main', 'feat/x', 'release-1.2'])('accepts a plain branch name (%s)', (ref) => {
    expect(parseBaseBranch(ref)).toBe(ref);
  });

  it.each(['', ' ', '\t\n'])('rejects an empty or whitespace-only ref (%j)', (ref) => {
    expect(parseBaseBranch(ref)).toBeUndefined();
  });

  it('rejects a ref starting with -', () => {
    expect(parseBaseBranch('-x')).toBeUndefined();
    expect(parseBaseBranch('--upload-pack=evil')).toBeUndefined();
  });

  it.each([
    'a b',
    'a\u0001b',
    'a\u007fb',
    'a..b',
    'a@{b',
    'a~b',
    'a^b',
    'a:b',
    'a?b',
    'a*b',
    'a[b',
    'a\\b',
    '/a',
    'a/',
    'a//b',
    'a.',
    'a.lock',
    'a/.hidden',
    'a/b.lock/c',
    '@',
  ])('rejects refs git check-ref-format forbids (%j)', (ref) => {
    expect(parseBaseBranch(ref)).toBeUndefined();
  });
});

describe('baseBranchOrExit', () => {
  it('passes undefined and valid refs through', () => {
    expect(baseBranchOrExit(undefined)).toBeUndefined();
    expect(baseBranchOrExit('feat/x')).toBe('feat/x');
  });

  it('throws CliExitError with exit code 2', () => {
    let caught: unknown;
    try {
      baseBranchOrExit('-x');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliExitError);
    expect((caught as CliExitError).code).toBe(2);
    expect((caught as CliExitError).message).toContain("invalid --base-branch '-x'");
  });
});

describe('baseBranchConflict', () => {
  it('is silent without a base branch', () => {
    expect(baseBranchConflict({ sizeGate: 'file', workspace: '/w' })).toBeUndefined();
  });

  it('accepts a bare base branch and --size-gate off', () => {
    expect(baseBranchConflict({ baseBranch: 'x' })).toBeUndefined();
    expect(baseBranchConflict({ baseBranch: 'x', sizeGate: 'off' })).toBeUndefined();
  });

  it('rejects --size-gate other than off or stack, and --workspace', () => {
    expect(baseBranchConflict({ baseBranch: 'x', sizeGate: 'stack' })).toBeUndefined();
    expect(baseBranchConflict({ baseBranch: 'x', sizeGate: 'file' })).toContain('size gate off or stack');
    expect(baseBranchConflict({ baseBranch: 'x', workspace: '/w' })).toContain('needs a factory worktree');
  });
});

describe('baseRemoteRef', () => {
  it('prefixes origin/', () => {
    expect(baseRemoteRef('feat/x')).toBe('origin/feat/x');
    expect(baseRemoteRef(undefined)).toBeUndefined();
  });
});

describe('resolveWorkspaceMode (#3904)', () => {
  it.each([
    [undefined, undefined, 'worktree'],
    [undefined, '', 'worktree'],
    [undefined, 'worktree', 'worktree'],
    [undefined, 'in-place', 'in-place'],
    [true, undefined, 'in-place'],
    [true, 'worktree', 'in-place'],
  ] as const)('flag %s with FACTORY_WORKSPACE %s gives %s', (flag, env, expected) => {
    expect(resolveWorkspaceMode(flag, { FACTORY_WORKSPACE: env })).toBe(expected);
  });

  it('resolveWorkspaceMode rejects an unknown FACTORY_WORKSPACE value', () => {
    const call = () => resolveWorkspaceMode(undefined, { FACTORY_WORKSPACE: 'docker' });
    expect(call).toThrow(CliExitError);
    expect(call).toThrow("unknown FACTORY_WORKSPACE 'docker'");
  });
});

describe('inPlaceConflict (#3904)', () => {
  it('refuses --base-branch and stack, allows the rest', () => {
    expect(inPlaceConflict({ baseBranch: 'dev' })).toContain('drop --base-branch');
    expect(inPlaceConflict({ sizeGate: 'stack' })).toContain('drop --stack');
    expect(inPlaceConflict({ sizeGate: 'off' })).toBeUndefined();
    expect(inPlaceConflict({})).toBeUndefined();
  });
});
