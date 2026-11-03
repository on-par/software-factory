import { describe, expect, it, type Mock, vi } from 'vitest';

import { PreviewConfigSchema } from '../config/preview-section.js';
import {
  findPreviewUrl,
  type PreviewComment,
  type PreviewDeployment,
  type PreviewDeploymentStatus,
  type PreviewGitHub,
} from './preview-source.js';

const SHA = 'abc1234'.padEnd(40, 'f');
const target = { owner: 'o', repo: 'r', prNumber: 7, headSha: SHA };
const HEAD_DATE = '2026-01-02T00:00:00Z';

interface Fixtures {
  deployments?: PreviewDeployment[];
  statuses?: Record<number, PreviewDeploymentStatus[]>;
  comments?: PreviewComment[];
  headCommitDate?: string;
}

function fakeGitHub(f: Fixtures): PreviewGitHub & { headCommitDate: Mock<PreviewGitHub['headCommitDate']> } {
  return {
    listDeployments: async () => f.deployments ?? [],
    listDeploymentStatuses: async (_target, id) => f.statuses?.[id] ?? [],
    listComments: async () => f.comments ?? [],
    headCommitDate: vi.fn(async () => f.headCommitDate),
  };
}

const commentSource = (over: Record<string, unknown> = {}) =>
  PreviewConfigSchema.parse({
    source: { kind: 'comment', urlPattern: 'Preview: (?<url>\\S+)', authors: ['Deploy-Bot[bot]'], ...over },
    command: ['x'],
  }).source;

const comment = (over: Partial<PreviewComment> = {}): PreviewComment => ({
  body: 'Preview: https://new.example.com',
  author: 'deploy-bot[bot]',
  authorAssociation: 'NONE',
  createdAt: '2026-01-03T00:00:00Z',
  updatedAt: '2026-01-03T00:00:00Z',
  ...over,
});

const deploymentSource = PreviewConfigSchema.parse({
  source: { kind: 'deployment', environment: 'preview/pr-*' },
  command: ['x'],
}).source;

describe('findPreviewUrl from a deployment', () => {
  it('takes the newest matching deployment whose newest status is success, preferring environment_url', async () => {
    const github = fakeGitHub({
      deployments: [
        { id: 1, environment: 'preview/pr-7', createdAt: '2026-01-01T00:00:00Z' },
        { id: 2, environment: 'preview/pr-7', createdAt: '2026-01-02T00:00:00Z' },
        { id: 3, environment: 'production', createdAt: '2026-01-03T00:00:00Z' },
      ],
      statuses: {
        1: [{ state: 'success', createdAt: '2026-01-01T00:00:00Z', environmentUrl: 'https://old.example.com' }],
        2: [
          { state: 'success', createdAt: '2026-01-02T00:00:00Z', environmentUrl: 'https://new.example.com' },
          { state: 'in_progress', createdAt: '2026-01-02T00:01:00Z', environmentUrl: 'https://x.example.com' },
        ],
        3: [{ state: 'success', createdAt: '2026-01-03T00:00:00Z', environmentUrl: 'https://prod.example.com' }],
      },
    });
    expect(await findPreviewUrl(github, target, deploymentSource)).toBe('https://old.example.com');
  });

  it('falls back to target_url when the status has no environment_url', async () => {
    const github = fakeGitHub({
      deployments: [{ id: 1, environment: 'preview/pr-7', createdAt: '2026-01-01T00:00:00Z' }],
      statuses: { 1: [{ state: 'success', createdAt: '2026-01-01T00:00:00Z', targetUrl: 'https://t.example.com' }] },
    });
    expect(await findPreviewUrl(github, target, deploymentSource)).toBe('https://t.example.com');
  });
});

describe('findPreviewUrl from a PR comment', () => {
  it('takes the URL from the newest trusted comment newer than the head commit', async () => {
    const github = fakeGitHub({
      headCommitDate: HEAD_DATE,
      comments: [
        comment({ body: 'Preview: https://newest.example.com', updatedAt: '2026-01-04T00:00:00Z' }),
        comment({ body: 'Preview: https://older.example.com', updatedAt: '2026-01-03T00:00:00Z' }),
      ],
    });
    expect(await findPreviewUrl(github, target, commentSource())).toBe('https://newest.example.com');
  });

  it('ignores a matching comment from an author outside the allow-list', async () => {
    const github = fakeGitHub({
      headCommitDate: HEAD_DATE,
      comments: [comment({ author: 'mallory', body: 'Preview: https://evil.example.com' })],
    });
    expect(await findPreviewUrl(github, target, commentSource())).toBeNull();
  });

  it('trusts a comment by its author association when associations are configured', async () => {
    const github = fakeGitHub({
      headCommitDate: HEAD_DATE,
      comments: [comment({ author: 'maintainer', authorAssociation: 'MEMBER' })],
    });
    const source = commentSource({ authors: [], authorAssociations: ['MEMBER'] });
    expect(await findPreviewUrl(github, target, source)).toBe('https://new.example.com');
  });

  it('ignores a trusted comment older than the head commit, so a rework push never reuses a stale preview', async () => {
    const github = fakeGitHub({
      headCommitDate: HEAD_DATE,
      comments: [comment({ updatedAt: '2026-01-01T00:00:00Z' })],
    });
    expect(await findPreviewUrl(github, target, commentSource())).toBeNull();
  });

  it('accepts an older comment that names the head SHA without reading the commit date', async () => {
    const github = fakeGitHub({
      comments: [
        comment({ body: `Preview for ${SHA.slice(0, 7)}: https://sha.example.com`, updatedAt: '2025-01-01T00:00:00Z' }),
      ],
    });
    const source = commentSource({ urlPattern: ': (?<url>https://\\S+)' });
    expect(await findPreviewUrl(github, target, source)).toBe('https://sha.example.com');
    expect(github.headCommitDate).not.toHaveBeenCalled();
  });

  it('uses capture group 1 when the pattern has no url group', async () => {
    const github = fakeGitHub({
      headCommitDate: HEAD_DATE,
      comments: [comment({ body: 'deployed to https://g.example.com' })],
    });
    const source = commentSource({ urlPattern: 'deployed to (\\S+)' });
    expect(await findPreviewUrl(github, target, source)).toBe('https://g.example.com');
  });

  it('finds nothing when the head commit date is unknown and no comment names the SHA', async () => {
    const github = fakeGitHub({ comments: [comment()] });
    expect(await findPreviewUrl(github, target, commentSource())).toBeNull();
  });
});
