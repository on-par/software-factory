import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyFailure } from '@on-par/factory-core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(HERE, 'bin');
const AGENTS = ['codex', 'opencode', 'command-agent'] as const;
const FAILURE_MODES = ['rate-limit', 'usage-cap', 'empty'] as const;

let repo: string;
let elsewhere: string;
let outFile: string;

function git(dir: string, ...args: string[]): string {
  const res = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

const commitCount = (dir: string): number => Number(git(dir, 'rev-list', '--count', 'HEAD'));

function recording(agent: string, file: string): string {
  try {
    return readFileSync(join(HERE, 'recordings', agent, file), 'utf8');
  } catch {
    return '';
  }
}

function runShim(agent: string, mode: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (mode === undefined) delete env.FAKE_AGENT_MODE;
  else env.FAKE_AGENT_MODE = mode;
  const codex = agent === 'codex';
  const args = codex
    ? [
        'exec',
        '--json',
        '--sandbox',
        'danger-full-access',
        '-c',
        'approval_policy=never',
        '-C',
        repo,
        '-o',
        outFile,
        '-',
      ]
    : agent === 'opencode'
      ? ['run', '--auto', '--format', 'json']
      : [];
  return spawnSync(join(BIN, agent), args, {
    cwd: codex ? elsewhere : repo,
    input: 'prompt text',
    encoding: 'utf8',
    env,
  });
}

describe.skipIf(process.platform === 'win32')('fake agent CLI shims', () => {
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'fake-agent-repo-'));
    elsewhere = mkdtempSync(join(tmpdir(), 'fake-agent-cwd-'));
    outFile = join(elsewhere, 'last-message.txt');
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it.each(AGENTS)('%s success mode prints the recording and commits', (agent) => {
    for (const mode of ['success', undefined, '']) {
      const before = commitCount(repo);
      const res = runShim(agent, mode);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe(recording(agent, 'success.stdout'));
      expect(commitCount(repo)).toBe(before + 1);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      if (agent === 'codex') {
        expect(readFileSync(outFile, 'utf8')).toBe(recording('codex', 'success.last-message'));
      }
    }
  });

  describe.each(AGENTS)('%s', (agent) => {
    it.each(FAILURE_MODES)('%s mode replays the recording without a commit', (mode) => {
      const before = commitCount(repo);
      const res = runShim(agent, mode);
      expect(res.status).toBe(mode === 'empty' ? 0 : 1);
      expect(res.stdout).toBe(recording(agent, `${mode}.stdout`));
      expect(res.stderr).toBe(recording(agent, `${mode}.stderr`));
      expect(commitCount(repo)).toBe(before);
      expect(git(repo, 'status', '--porcelain')).toBe('');
      if (agent === 'codex' && mode === 'empty') expect(readFileSync(outFile, 'utf8')).toBe('');
    });

    it('classifies the recorded failures', () => {
      for (const [mode, reason] of [
        ['rate-limit', 'rate_limit'],
        ['usage-cap', 'usage_cap'],
      ] as const) {
        const res = runShim(agent, mode);
        expect(classifyFailure(`${res.stderr}\n${res.stdout}`, 1)).toBe(reason);
      }
    });

    it.each(['bogus', 'SUCCESS'])('rejects unknown mode %s', (mode) => {
      const before = commitCount(repo);
      const res = runShim(agent, mode);
      expect(res.status).toBe(2);
      expect(res.stderr).toContain('unknown FAKE_AGENT_MODE');
      expect(commitCount(repo)).toBe(before);
    });
  });
});
