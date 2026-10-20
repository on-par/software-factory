import { describe, expect, it } from 'vitest';

import { blockedNoChangeSpecReason, specWriteDenied } from './plan-spec-write.js';

const specPath = '/repo/.factory/state/plans/issue-3269.md';
const plansPath = '/repo/.factory/state/plans';
const phrases = [
  'sandbox denied',
  'Operation not permitted',
  'EACCES',
  'EPERM',
  'outside the writable',
  'read-only file system',
];

describe('specWriteDenied', () => {
  it.each(phrases)('matches %s when the full spec path is named', (phrase) => {
    expect(specWriteDenied(`${phrase}: ${specPath}`, specPath)).toBe(true);
  });

  it.each(phrases)('matches %s when the full plans directory is named', (phrase) => {
    expect(specWriteDenied(`${phrase}: ${plansPath}`, specPath)).toBe(true);
  });

  it('matches mixed case, quoted paths, adjacent lines, and trailing separators', () => {
    expect(specWriteDenied(`sAnDbOx DeNiEd\n'${specPath}'`, specPath)).toBe(true);
    expect(specWriteDenied(`EACCES at \`${plansPath}///\``, specPath)).toBe(true);
  });

  it('treats paths with regex characters literally', () => {
    const literalPath = '/repo/plans/[issue](3269)+.md';
    expect(specWriteDenied(`EPERM: ${literalPath}`, literalPath)).toBe(true);
    expect(specWriteDenied('EPERM: /repo/plans/issue3269.md', literalPath)).toBe(false);
  });

  it('rejects empty paths, unrelated destinations, siblings, and another filename', () => {
    expect(specWriteDenied('EACCES: /repo/plans/issue-3269.md', '')).toBe(false);
    expect(specWriteDenied('EACCES: /repo/other/issue-3269.md', specPath)).toBe(false);
    expect(specWriteDenied(`EACCES: ${plansPath}-backup`, specPath)).toBe(false);
    expect(specWriteDenied(`EACCES: ${plansPath}/issue-3103.md`, specPath)).toBe(false);
  });

  it('requires a listed denial phrase and destination boundaries', () => {
    for (const output of [
      `failed to write ${specPath}`,
      `permission blocked for ${specPath}`,
      `EACCESX: ${specPath}`,
      `EPERM_1: ${specPath}`,
      'EACCES: /repo/plans-old/issue-3269.md',
      'read-only file systems: /repo/plans/issue-3269.md.bak',
    ]) {
      expect(specWriteDenied(output, specPath)).toBe(false);
    }
  });
});

describe('blockedNoChangeSpecReason', () => {
  it('retains the blocked/no-change note classification', () => {
    expect(blockedNoChangeSpecReason('Blocked: no files changed in sandbox')).toBe(
      'PLAN returned a blocked/no-change note instead of a frozen spec',
    );
    expect(blockedNoChangeSpecReason('A valid spec with changes')).toBeNull();
  });
});
