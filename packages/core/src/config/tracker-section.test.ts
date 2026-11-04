import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createTempDirs } from '@on-par/factory-core/testing';

import { loadFactoryConfig, loadFactoryConfigForRepo, resolveTrackerConfig, TrackerConfigSchema } from './index.js';
import { loadRepoConfig } from './repo.js';

const tempDirs = createTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function repoWith(config: unknown): Promise<string> {
  const dir = await tempDirs.make('tracker-config-');
  await mkdir(join(dir, '.factory'), { recursive: true });
  await writeFile(join(dir, '.factory', 'config.json'), JSON.stringify(config));
  return dir;
}

describe('tracker config (#3891)', () => {
  it('defaults tracker kind to github when the key is absent', async () => {
    expect(loadFactoryConfig().tracker).toEqual({ kind: 'github' });
    const dir = await repoWith({ version: 2 });
    expect(loadFactoryConfigForRepo(join(dir, '.factory', 'config.json')).tracker).toEqual({ kind: 'github' });
  });

  it('loads a repo config file without a tracker key with only the github default added', async () => {
    const dir = await repoWith({ version: 2 });
    expect(loadRepoConfig(dir)).toEqual({ version: 2 });
    const { tracker, ...rest } = loadFactoryConfigForRepo(join(dir, '.factory', 'config.json'));
    const { tracker: defaultTracker, ...defaults } = loadFactoryConfig();
    expect(tracker).toEqual({ kind: 'github' });
    expect(defaultTracker).toEqual({ kind: 'github' });
    expect(rest).toEqual(defaults);
  });

  it('accepts a full linear block', () => {
    const parsed = TrackerConfigSchema.parse({
      kind: 'linear',
      linear: {
        teamKey: 'ENG',
        projects: { Factory: 'owner/repo' },
        readyLabel: 'ready',
        laneLabelGroup: 'lanes',
        states: { ready: 'Ready', inProgress: 'Doing', parked: 'Backlog' },
      },
    });
    expect(parsed.linear?.states).toEqual({ ready: 'Ready', inProgress: 'Doing', parked: 'Backlog' });
    expect(parsed.linear?.projects).toEqual({ Factory: 'owner/repo' });
  });

  it('defaults omitted labels and states', () => {
    const parsed = TrackerConfigSchema.parse({ kind: 'linear', linear: { teamKey: 'ENG' } });
    expect(parsed.linear).toEqual({
      teamKey: 'ENG',
      projects: {},
      readyLabel: 'factory:ready',
      laneLabelGroup: 'lane',
      states: { ready: 'Todo', inProgress: 'In Progress', parked: 'Todo' },
    });
  });

  it('rejects an unknown tracker kind', () => {
    expect(TrackerConfigSchema.safeParse({ kind: 'jira' }).success).toBe(false);
    expect(TrackerConfigSchema.safeParse({ kind: 'Linear' }).success).toBe(false);
  });

  it('rejects kind linear without a linear block', () => {
    const r = TrackerConfigSchema.safeParse({ kind: 'linear' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('tracker.kind linear needs a tracker.linear block');
  });

  it('rejects an apiKey in the linear block', () => {
    expect(TrackerConfigSchema.safeParse({ kind: 'linear', linear: { teamKey: 'ENG', apiKey: 'x' } }).success).toBe(
      false,
    );
  });

  it('rejects a project value that is not owner/repo', () => {
    expect(
      TrackerConfigSchema.safeParse({ kind: 'linear', linear: { teamKey: 'ENG', projects: { P: 'nope' } } }).success,
    ).toBe(false);
  });

  it('resolves a config with no tracker to github', () => {
    expect(resolveTrackerConfig({})).toEqual({ kind: 'github' });
  });
});
