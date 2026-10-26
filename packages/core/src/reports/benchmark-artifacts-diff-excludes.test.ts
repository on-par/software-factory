// src/reports/benchmark-artifacts-diff-excludes.test.ts — DIFF_EXCLUDES handling, split out of benchmark-artifacts.test.ts

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { DIFF_EXCLUDES } from '../checkers/design-smells.js';
import { workKeyFromIssue } from '../work/work-key.js';
import { writeBenchmarkArtifacts } from './benchmark-artifacts.js';

const EXCLUDE = `-- . ${DIFF_EXCLUDES.map((p) => `'${p}'`).join(' ')}`;

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe('DIFF_EXCLUDES', () => {
  async function setup() {
    const tmpDir = await tempDirs.make('factory-artifacts-');
    const eventsFile = join(tmpDir, 'events.ndjson');
    const costsFile = join(tmpDir, 'costs.jsonl');
    const artifactsDir = join(tmpDir, 'artifacts');
    const workspace = join(tmpDir, 'workspace');
    mkdirSync(workspace);
    mkdirSync(artifactsDir);
    writeFileSync(eventsFile, '');
    writeFileSync(costsFile, '');
    return { eventsFile, costsFile, artifactsDir, workspace };
  }

  it('excludes cache-only churn entirely: empty diff.patch and empty changedFiles', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();

    const result = await writeBenchmarkArtifacts(
      {
        issue: workKeyFromIssue(137),
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async (command) => {
          if (command === `git status --short ${EXCLUDE}`) return { stdout: '', stderr: '' };
          if (command === `git diff --stat origin/main...HEAD ${EXCLUDE}`) return { stdout: '', stderr: '' };
          if (command === `git diff origin/main...HEAD ${EXCLUDE}`) return { stdout: '', stderr: '' };
          if (command === `git diff --name-status origin/main...HEAD ${EXCLUDE}`) return { stdout: '', stderr: '' };
          if (command === `git diff ${EXCLUDE}`) return { stdout: '', stderr: '' };
          throw new Error(`unexpected command: ${command}`);
        },
      },
    );

    const diffOnDisk = readFileSync(join(artifactsDir, 'diff.patch'), 'utf-8');
    expect(diffOnDisk).toBe('');
    expect(diffOnDisk).not.toContain('__pycache__');
    expect(result.manifest.git.changedFiles).toEqual([]);
    expect(result.manifest.git.changedFiles.join('')).not.toContain('__pycache__');
  });

  it('keeps real changes when excluded noise is also present', async () => {
    const { eventsFile, costsFile, artifactsDir, workspace } = await setup();

    const result = await writeBenchmarkArtifacts(
      {
        issue: workKeyFromIssue(137),
        artifactsDir,
        eventsFile,
        costsFile,
        startedAt: '2026-07-28T02:27:00.000Z',
        outcome: 'ready',
        workspace,
      },
      {
        now: () => new Date('2026-07-28T02:30:00.000Z'),
        run: async (command) => {
          if (command === `git status --short ${EXCLUDE}`) return { stdout: 'M app.py\n', stderr: '' };
          if (command === `git diff --stat origin/main...HEAD ${EXCLUDE}`)
            return { stdout: 'app.py | 1 +\n', stderr: '' };
          if (command === `git diff origin/main...HEAD ${EXCLUDE}`)
            return { stdout: 'diff --git a/app.py b/app.py\n+real change\n', stderr: '' };
          if (command === `git diff --name-status origin/main...HEAD ${EXCLUDE}`)
            return { stdout: 'M\tapp.py\n', stderr: '' };
          if (command === `git diff ${EXCLUDE}`) return { stdout: '', stderr: '' };
          throw new Error(`unexpected command: ${command}`);
        },
      },
    );

    const diffOnDisk = readFileSync(join(artifactsDir, 'diff.patch'), 'utf-8');
    expect(diffOnDisk).toBe('diff --git a/app.py b/app.py\n+real change\n');
    expect(diffOnDisk).not.toContain('__pycache__');
    expect(result.manifest.git.changedFiles).toEqual(['app.py']);
  });
});
