import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createTempDirs } from '@on-par/factory-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from './cli/index.js';

const tmp = createTempDirs();
let repo: string;
let cwd: string;
let logLines: string[];

beforeEach(() => {
  cwd = process.cwd();
  repo = realpathSync(tmp.makeSync('cli-ack-demotion-'));
  execSync('git init -q', { cwd: repo });
  mkdirSync(join(repo, '.factory', 'state'), { recursive: true });
  process.chdir(repo);
  logLines = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => logLines.push(args.join(' ')));
});

afterEach(async () => {
  process.chdir(cwd);
  await tmp.cleanup();
  vi.restoreAllMocks();
});

const logged = () => logLines.join('\n');

describe('factory classifier ack-demotion (#1959)', () => {
  it('says there is nothing to acknowledge', async () => {
    await main(['node', 'factory', 'classifier', 'ack-demotion']);
    expect(logged()).toContain('No unacknowledged tier demotions.');
  });

  it('acknowledges an open demotion', async () => {
    const file = join(repo, '.factory', 'state', 'tier-demotions.jsonl');
    const open = {
      type: 'tier-demoted',
      from: 'T2',
      to: 'T1',
      mergedUnder: 'T2',
      prNumber: 42,
      issue: '7',
      recordedAt: '2026-01-01T00:00:00.000Z',
      acknowledgedAt: null,
    };
    writeFileSync(file, `${JSON.stringify(open)}\n`);
    await main(['node', 'factory', 'classifier', 'ack-demotion']);
    expect(logged()).toContain('acknowledged PR #42 T2→T1');
    expect(JSON.parse(readFileSync(file, 'utf8').trim()).acknowledgedAt).not.toBeNull();
  });
});
