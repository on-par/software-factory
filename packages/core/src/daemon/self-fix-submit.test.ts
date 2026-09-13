import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getFactoryPaths } from '../config/index.js';
import type { FilingGitHubClient } from '../filing/index.js';
import { submitDaemonSelfFix } from './self-fix-submit.js';

const body = {
  repo: 'on-par/software-factory',
  fingerprint: 'ff_0123456789abcdef',
  evidence: {
    repo: 'on-par/software-factory',
    issue: '1392',
    model: 'codex',
    component: 'factoryd',
    eventExcerpt: 'failure',
    logPath: '/tmp/factory.log',
    phase: 'build',
    origin: 'factory-internal',
    reason: 'error',
  },
};

function fakeClient(): FilingGitHubClient {
  return {
    async listCandidateIssues() {
      return [];
    },
    async createIssue() {
      return { number: 1 };
    },
    async updateIssue() {},
    async addLabels() {},
    async commentIssue() {},
  };
}

describe('submitDaemonSelfFix', () => {
  let dir: string;
  let registryFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'self-fix-submit-'));
    registryFile = join(dir, 'registry.json');
    const checkout = join(dir, 'checkout');
    const config = getFactoryPaths(checkout).config;
    await mkdir(join(checkout, '.factory'), { recursive: true });
    await writeFile(config, JSON.stringify({ version: 2, filing: { selfFixLabel: 'needs-human-merge' } }));
    await writeFile(
      registryFile,
      JSON.stringify({
        version: 1,
        repos: {
          'on-par/software-factory': { path: checkout, attachedAt: '2026-09-12T00:00:00.000Z', state: 'active' },
          'on-par/detached': { path: checkout, attachedAt: '2026-09-12T00:00:00.000Z', state: 'detached' },
        },
      }),
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    null,
    { ...body, repo: 'bad slug' },
    { ...body, fingerprint: 'bad' },
    { ...body, evidence: { ...body.evidence, phase: undefined } },
    { ...body, evidence: { ...body.evidence, origin: 'bad' } },
    { ...body, evidence: { ...body.evidence, reason: 'bad' } },
  ])('rejects malformed input', async (input) =>
    expect(await submitDaemonSelfFix(registryFile, input)).toMatchObject({ ok: false, reason: 'invalid-request' }),
  );

  it('rejects unknown and detached repos', async () => {
    await expect(submitDaemonSelfFix(registryFile, { ...body, repo: 'on-par/nope' })).resolves.toMatchObject({
      reason: 'unknown-repo',
    });
    await expect(submitDaemonSelfFix(registryFile, { ...body, repo: 'on-par/detached' })).resolves.toMatchObject({
      reason: 'unknown-repo',
    });
  });

  it('reports when no filing client is wired', async () => {
    await expect(submitDaemonSelfFix(registryFile, body)).resolves.toMatchObject({ reason: 'not-wired' });
  });

  it('reads the attached checkout filing policy', async () => {
    const result = await submitDaemonSelfFix(registryFile, body, { client: fakeClient() });
    expect(result).toMatchObject({
      ok: true,
      result: { action: 'created', labels: expect.arrayContaining(['needs-human-merge']) },
    });
  });
});
