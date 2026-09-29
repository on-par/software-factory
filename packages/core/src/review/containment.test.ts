import { describe, expect, it, vi } from 'vitest';

import type { ContainerEngine } from '../hosted/container.js';
import {
  isCrossRepoPullRequest,
  isForkPullRequest,
  resolveReviewContainment,
  REVIEW_CONTAINED_FLAG_HELP,
  REVIEW_CONTAINMENT_REFUSED_EXIT_CODE,
  runContainmentGatedReview,
  type ReviewPullRequestRepos,
} from './containment.js';

const sameRepo: ReviewPullRequestRepos = { number: 7, baseRepo: 'acme/app', headRepo: 'acme/app' };
const fork: ReviewPullRequestRepos = { number: 8, baseRepo: 'acme/app', headRepo: 'mallory/app' };

function engineWith(isAvailable?: () => Promise<boolean>): ContainerEngine {
  const partial: Partial<ContainerEngine> = isAvailable ? { isAvailable } : {};
  return partial as ContainerEngine;
}

function spies() {
  return {
    runOnHost: vi.fn(async () => ({ exitCode: 0 })),
    runContained: vi.fn(async () => ({ exitCode: 0 })),
    write: vi.fn(),
  };
}

describe('isForkPullRequest', () => {
  it('treats identical repos as same-repo', () => {
    expect(isForkPullRequest(sameRepo)).toBe(false);
  });
  it('ignores case and whitespace', () => {
    expect(isForkPullRequest({ number: 1, baseRepo: 'Acme/App', headRepo: ' acme/app ' })).toBe(false);
  });
  it('flags a different owner as a fork', () => {
    expect(isForkPullRequest(fork)).toBe(true);
  });
  it('flags an unknown head repo as a fork', () => {
    expect(isForkPullRequest({ ...sameRepo, headRepo: null })).toBe(true);
    expect(isForkPullRequest({ ...sameRepo, headRepo: '' })).toBe(true);
  });
});

describe('isCrossRepoPullRequest', () => {
  it('is false without a usable currentRepo', () => {
    expect(isCrossRepoPullRequest(sameRepo, undefined)).toBe(false);
    expect(isCrossRepoPullRequest(sameRepo, '  ')).toBe(false);
  });
  it('ignores case and whitespace', () => {
    expect(isCrossRepoPullRequest(sameRepo, ' ACME/App ')).toBe(false);
  });
  it('is true when the base repo differs from the current checkout', () => {
    expect(isCrossRepoPullRequest(sameRepo, 'me/here')).toBe(true);
  });
});

describe('resolveReviewContainment', () => {
  it('routes same-repo PRs to the host without probing Docker', async () => {
    const isAvailable = vi.fn(async () => false);
    expect(await resolveReviewContainment(sameRepo, engineWith(isAvailable))).toEqual({ kind: 'host' });
    expect(isAvailable).not.toHaveBeenCalled();
  });

  it('refuses a fork when Docker reports unavailable', async () => {
    const decision = await resolveReviewContainment(
      fork,
      engineWith(async () => false),
    );
    expect(decision).toMatchObject({ kind: 'refused', exitCode: 2 });
  });

  it('refuses a fork when the probe rejects', async () => {
    const decision = await resolveReviewContainment(
      fork,
      engineWith(async () => {
        throw new Error('boom');
      }),
    );
    expect(decision.kind).toBe('refused');
  });

  it('refuses a fork when the engine has no probe', async () => {
    expect((await resolveReviewContainment(fork, engineWith())).kind).toBe('refused');
  });

  it('returns contained for a fork with Docker available', async () => {
    expect(
      await resolveReviewContainment(
        fork,
        engineWith(async () => true),
      ),
    ).toEqual({ kind: 'contained' });
  });

  describe('forceContained (#1687)', () => {
    it('routes a same-repo PR to containment when Docker is available', async () => {
      const isAvailable = vi.fn(async () => true);
      expect(await resolveReviewContainment(sameRepo, engineWith(isAvailable), { forceContained: true })).toEqual({
        kind: 'contained',
      });
      expect(isAvailable).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the probe reports unavailable', async () => false],
      [
        'the probe rejects',
        async () => {
          throw new Error('boom');
        },
      ],
      ['the engine has no probe', undefined],
    ])('refuses a same-repo PR when %s', async (_name, probe) => {
      const decision = await resolveReviewContainment(sameRepo, engineWith(probe), { forceContained: true });
      expect(decision).toMatchObject({ kind: 'refused', exitCode: 2 });
      const message = decision.kind === 'refused' ? decision.message : '';
      expect(message).toContain('containment is required');
      expect(message).toContain('--contained');
      expect(message).not.toContain(' comes from ');
    });

    it.each([[{ forceContained: false }], [{}], [undefined]])(
      'keeps a same-repo PR on the host without probing for %j',
      async (options) => {
        const isAvailable = vi.fn(async () => false);
        expect(await resolveReviewContainment(sameRepo, engineWith(isAvailable), options)).toEqual({ kind: 'host' });
        expect(isAvailable).not.toHaveBeenCalled();
      },
    );

    it('keeps the fork wording for a fork PR', async () => {
      const decision = await resolveReviewContainment(fork, engineWith(), { forceContained: true });
      const message = decision.kind === 'refused' ? decision.message : '';
      expect(message).toContain('mallory/app');
      expect(message).not.toContain('--contained');
    });
  });
});

describe('cross-repo PRs (#1673)', () => {
  const other: ReviewPullRequestRepos = { number: 9, baseRepo: 'other/repo', headRepo: 'other/repo' };

  it('contains a cross-repo PR when Docker is available', async () => {
    const decision = await resolveReviewContainment(
      other,
      engineWith(async () => true),
      { currentRepo: 'me/here' },
    );
    expect(decision).toEqual({ kind: 'contained' });
  });

  it.each([
    ['the probe reports unavailable', async () => false],
    [
      'the probe rejects',
      async () => {
        throw new Error('boom');
      },
    ],
    ['the engine has no probe', undefined],
  ])('refuses a cross-repo PR when %s', async (_name, probe) => {
    const decision = await resolveReviewContainment(other, engineWith(probe), { currentRepo: 'me/here' });
    expect(decision).toMatchObject({ kind: 'refused', exitCode: 2 });
    const message = decision.kind === 'refused' ? decision.message : '';
    expect(message).toContain('other/repo#9');
    expect(message).toContain('me/here');
    expect(message).not.toContain('--contained');
  });

  it('keeps a matching or unspecified currentRepo on the host without probing', async () => {
    const isAvailable = vi.fn(async () => false);
    expect(await resolveReviewContainment(other, engineWith(isAvailable), { currentRepo: 'Other/Repo' })).toEqual({
      kind: 'host',
    });
    expect(await resolveReviewContainment(other, engineWith(isAvailable))).toEqual({ kind: 'host' });
    expect(isAvailable).not.toHaveBeenCalled();
  });

  it('runs a cross-repo PR through the contained runner, never the host', async () => {
    const s = spies();
    const result = await runContainmentGatedReview({
      pr: other,
      engine: engineWith(async () => true),
      currentRepo: 'me/here',
      ...s,
    });
    expect(result).toEqual({ exitCode: 0 });
    expect(s.runContained).toHaveBeenCalledTimes(1);
    expect(s.runOnHost).not.toHaveBeenCalled();
  });

  it('refuses with exit 2 and cross-repo wording when there is no contained runner', async () => {
    const s = spies();
    const result = await runContainmentGatedReview({
      pr: other,
      engine: engineWith(async () => true),
      currentRepo: 'me/here',
      runOnHost: s.runOnHost,
      write: s.write,
    });
    expect(result).toEqual({ exitCode: 2 });
    expect(s.write).toHaveBeenCalledWith(expect.stringContaining('not the current checkout me/here'));
    expect(s.runOnHost).not.toHaveBeenCalled();
  });
});

describe('runContainmentGatedReview', () => {
  it('refuses a fork with exit 2 and runs nothing when Docker is unavailable', async () => {
    const s = spies();
    const result = await runContainmentGatedReview({ pr: fork, engine: engineWith(async () => false), ...s });
    expect(result).toEqual({ exitCode: REVIEW_CONTAINMENT_REFUSED_EXIT_CODE });
    expect(s.write).toHaveBeenCalledTimes(1);
    const message = s.write.mock.calls[0]?.[0] as string;
    expect(message).toContain('containment is required');
    expect(message).toContain('mallory/app');
    expect(message).toContain('acme/app');
    expect(s.runOnHost).not.toHaveBeenCalled();
    expect(s.runContained).not.toHaveBeenCalled();
  });

  it('refuses a fork with Docker available but no contained runner', async () => {
    const s = spies();
    const result = await runContainmentGatedReview({
      pr: fork,
      engine: engineWith(async () => true),
      runOnHost: s.runOnHost,
      write: s.write,
    });
    expect(result).toEqual({ exitCode: 2 });
    expect(s.write).toHaveBeenCalledWith(expect.stringContaining('containment is required'));
    expect(s.runOnHost).not.toHaveBeenCalled();
  });

  it('names an unknown head repository in the refusal', async () => {
    const s = spies();
    await runContainmentGatedReview({ pr: { ...fork, headRepo: null }, engine: engineWith(), ...s });
    expect(s.write).toHaveBeenCalledWith(expect.stringContaining('an unknown head repository'));
  });

  it('runs the contained runner for a fork with Docker available', async () => {
    const s = spies();
    s.runContained.mockResolvedValue({ exitCode: 0 });
    const result = await runContainmentGatedReview({ pr: fork, engine: engineWith(async () => true), ...s });
    expect(result).toEqual({ exitCode: 0 });
    expect(s.runContained).toHaveBeenCalledTimes(1);
    expect(s.runOnHost).not.toHaveBeenCalled();
    expect(s.write).not.toHaveBeenCalled();
  });

  it('runs same-repo PRs on the host even when Docker is missing', async () => {
    const s = spies();
    const isAvailable = vi.fn(async () => false);
    const result = await runContainmentGatedReview({ pr: sameRepo, engine: engineWith(isAvailable), ...s });
    expect(result).toEqual({ exitCode: 0 });
    expect(s.runOnHost).toHaveBeenCalledTimes(1);
    expect(s.write).not.toHaveBeenCalled();
    expect(isAvailable).not.toHaveBeenCalled();
    expect(s.runContained).not.toHaveBeenCalled();
  });

  it('propagates a non-zero host exit code', async () => {
    const s = spies();
    s.runOnHost.mockResolvedValue({ exitCode: 1 });
    expect(await runContainmentGatedReview({ pr: sameRepo, engine: engineWith(), ...s })).toEqual({ exitCode: 1 });
  });

  describe('forceContained (#1687)', () => {
    it('runs a same-repo PR through the contained runner and propagates its exit code', async () => {
      const s = spies();
      s.runContained.mockResolvedValue({ exitCode: 1 });
      const result = await runContainmentGatedReview({
        pr: sameRepo,
        engine: engineWith(async () => true),
        forceContained: true,
        ...s,
      });
      expect(result).toEqual({ exitCode: 1 });
      expect(s.runContained).toHaveBeenCalledTimes(1);
      expect(s.runOnHost).not.toHaveBeenCalled();
      expect(s.write).not.toHaveBeenCalled();
    });

    it('refuses with exit 2 and runs nothing when Docker is unavailable', async () => {
      const s = spies();
      const result = await runContainmentGatedReview({
        pr: sameRepo,
        engine: engineWith(async () => false),
        forceContained: true,
        ...s,
      });
      expect(result).toEqual({ exitCode: REVIEW_CONTAINMENT_REFUSED_EXIT_CODE });
      expect(s.write).toHaveBeenCalledTimes(1);
      expect(s.write).toHaveBeenCalledWith(expect.stringContaining('containment is required'));
      expect(s.runOnHost).not.toHaveBeenCalled();
      expect(s.runContained).not.toHaveBeenCalled();
    });

    it('refuses without a contained runner and never runs on the host', async () => {
      const s = spies();
      const result = await runContainmentGatedReview({
        pr: sameRepo,
        engine: engineWith(async () => true),
        forceContained: true,
        runOnHost: s.runOnHost,
        write: s.write,
      });
      expect(result).toEqual({ exitCode: 2 });
      expect(s.write).toHaveBeenCalledWith(expect.stringContaining('containment is required'));
      expect(s.write).toHaveBeenCalledWith(expect.stringContaining('--contained'));
      expect(s.runOnHost).not.toHaveBeenCalled();
    });
  });
});

describe('REVIEW_CONTAINED_FLAG_HELP', () => {
  it('describes the docker requirement and the refusal', () => {
    expect(REVIEW_CONTAINED_FLAG_HELP).toContain('Docker');
    expect(REVIEW_CONTAINED_FLAG_HELP).toContain('exit 2');
  });
});
