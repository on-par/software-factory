import { describe, expect, it } from 'vitest';

import type { CiFailureEvidence } from '../types/index.js';
import { renderCiFailureNote } from './ci-failure-note.js';

const sha = 'a'.repeat(20) + '1b2c3d4e5f60718293a4';

describe('renderCiFailureNote (#3998)', () => {
  it('is empty without failing checks', () => {
    expect(renderCiFailureNote(undefined)).toBe('');
    expect(renderCiFailureNote({ failingChecks: [], alerts: [], truncated: false })).toBe('');
  });

  it('renders url, attribution, flagged files, unredacted commit SHAs, and collection errors', () => {
    const ev: CiFailureEvidence = {
      failingChecks: [{ name: 'gitleaks', conclusion: 'failure', url: 'https://gh/run/1' }],
      alerts: [],
      truncated: false,
      errors: ['checks: boom'],
      attribution: {
        baseline: true,
        items: [{ kind: 'check', ref: 'gitleaks', attributable: false, reason: 'also failing on base main@abc' }],
      },
      jobLogs: [{ name: 'gitleaks', jobId: 1, excerpt: 'RAW LOG', truncated: false, files: ['x.ts'], commits: [sha] }],
    };
    const note = renderCiFailureNote(ev);
    expect(note).toContain('- gitleaks (failure) — run: https://gh/run/1');
    expect(note).toContain('attribution: also failing on base main@abc');
    expect(note).toContain('flagged files: x.ts');
    expect(note).toContain(`flagged commits: ${sha}`);
    expect(note).toContain('Collection errors: checks: boom');
    expect(note).not.toContain('RAW LOG');
  });

  it('says when the link or flags are missing', () => {
    const note = renderCiFailureNote({
      failingChecks: [{ name: 'lint', conclusion: 'failure' }],
      alerts: [],
      truncated: false,
      jobLogs: [{ name: 'lint', jobId: 2, excerpt: '', truncated: false }],
    });
    expect(note).toContain('run link unavailable');
    expect(note).toContain('flagged files: none flagged');
    expect(note).toContain('flagged commits: none flagged');
  });

  it.each([
    ['present', { failingStep: 'npm test' }, true],
    ['absent', {}, false],
  ])('renders the failing step line only when %s', (_label, extra, shown) => {
    const note = renderCiFailureNote({
      failingChecks: [{ name: 'unit', conclusion: 'failure' }],
      alerts: [],
      truncated: false,
      jobLogs: [{ name: 'unit', jobId: 1, excerpt: '', truncated: false, ...extra }],
    });
    expect(note.includes('  failing step: npm test')).toBe(shown);
  });

  it('redacts secrets in the failing step', () => {
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const note = renderCiFailureNote({
      failingChecks: [{ name: 'unit', conclusion: 'failure' }],
      alerts: [],
      truncated: false,
      jobLogs: [{ name: 'unit', jobId: 1, excerpt: '', truncated: false, failingStep: `curl -H ${token}` }],
    });
    expect(note).toContain('failing step: curl -H');
    expect(note).not.toContain(token);
  });

  it('bounds checks and flagged lists to 10', () => {
    const many = Array.from({ length: 15 }, (_, i) => `f${i}.ts`);
    const ev: CiFailureEvidence = {
      failingChecks: Array.from({ length: 15 }, (_, i) => ({ name: `c${i}`, conclusion: 'failure' })),
      alerts: [],
      truncated: false,
      jobLogs: [{ name: 'c0', jobId: 1, excerpt: '', truncated: false, files: many }],
    };
    const note = renderCiFailureNote(ev);
    expect(note.match(/^- c/gm)).toHaveLength(10);
    expect(note).toContain('f9.ts');
    expect(note).not.toContain('f10.ts');
  });
});
