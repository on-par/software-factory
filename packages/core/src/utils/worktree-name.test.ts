import { describe, expect, it } from 'vitest';
import { legacyWorktreeDirName, worktreeDirName } from './worktree-name.js';
import { toWorkKey, workKeyFromIssue } from '../work/work-key.js';

describe('worktreeDirName', () => {
  it('appends a non-numeric tracker key verbatim', () => {
    expect(worktreeDirName('main', toWorkKey('PROJ-123'), 'factory')).toBe('main-factory-PROJ-123');
    expect(legacyWorktreeDirName('main', toWorkKey('PROJ-123'), 'factory')).toBe('main-factory-factory-PROJ-123');
  });

  it('collapses the default factory prefix', () => {
    expect(worktreeDirName('main', workKeyFromIssue(5), 'factory')).toBe('main-factory-5');
    expect(worktreeDirName('main', workKeyFromIssue(5), 'factory')).not.toContain('factory-factory');
    expect(worktreeDirName('main', workKeyFromIssue(5), 'factory')).toMatch(/^main-factory-\d+$/);
  });

  it('dedups against a repo name ending in factory', () => {
    const name = worktreeDirName('software-factory', workKeyFromIssue(1709), 'factory');
    expect(name).toBe('software-factory-1709');
    expect(name).not.toContain('factory-factory');
  });

  it('leaves custom prefixes unchanged', () => {
    expect(worktreeDirName('main', workKeyFromIssue(5), 'ship-it')).toBe('main-factory-ship-it-5');
    expect(worktreeDirName('main', workKeyFromIssue(5), 'sf')).toBe('main-factory-sf-5');
    expect(worktreeDirName('main', workKeyFromIssue(5), undefined)).toBe('main-factory-ship-it-5');
    expect(worktreeDirName('software-factory', workKeyFromIssue(7), 'ship-it')).toBe('software-factory-ship-it-7');
  });

  it('normalizes the prefix slug', () => {
    expect(worktreeDirName('main', workKeyFromIssue(5), 'Factory')).toBe('main-factory-5');
  });

  it('dedups whole segments only', () => {
    expect(worktreeDirName('myfactory', workKeyFromIssue(2), 'factory')).toBe('myfactory-factory-2');
  });

  it('handles a repo named exactly factory', () => {
    expect(worktreeDirName('factory', workKeyFromIssue(3), 'factory')).toBe('factory-3');
  });
});

describe('legacyWorktreeDirName', () => {
  it('keeps the pre-#2763 repeated segments', () => {
    expect(legacyWorktreeDirName('software-factory', workKeyFromIssue(2149), 'factory')).toBe(
      'software-factory-factory-factory-2149',
    );
    expect(legacyWorktreeDirName('main', workKeyFromIssue(5), 'sf')).toBe('main-factory-sf-5');
  });
});
