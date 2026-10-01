import { describe, expect, it } from 'vitest';
import { worktreeDirName } from './worktree-name.js';

describe('worktreeDirName', () => {
  it('collapses the default factory prefix', () => {
    expect(worktreeDirName('main', 5, 'factory')).toBe('main-factory-5');
    expect(worktreeDirName('main', 5, 'factory')).not.toContain('factory-factory');
    expect(worktreeDirName('main', 5, 'factory')).toMatch(/^main-factory-\d+$/);
  });

  it('dedups against a repo name ending in factory', () => {
    const name = worktreeDirName('software-factory', 1709, 'factory');
    expect(name).toBe('software-factory-1709');
    expect(name).not.toContain('factory-factory');
  });

  it('leaves custom prefixes unchanged', () => {
    expect(worktreeDirName('main', 5, 'ship-it')).toBe('main-factory-ship-it-5');
    expect(worktreeDirName('main', 5, 'sf')).toBe('main-factory-sf-5');
    expect(worktreeDirName('main', 5, undefined)).toBe('main-factory-ship-it-5');
    expect(worktreeDirName('software-factory', 7, 'ship-it')).toBe('software-factory-ship-it-7');
  });

  it('normalizes the prefix slug', () => {
    expect(worktreeDirName('main', 5, 'Factory')).toBe('main-factory-5');
  });

  it('dedups whole segments only', () => {
    expect(worktreeDirName('myfactory', 2, 'factory')).toBe('myfactory-factory-2');
  });

  it('handles a repo named exactly factory', () => {
    expect(worktreeDirName('factory', 3, 'factory')).toBe('factory-3');
  });
});
