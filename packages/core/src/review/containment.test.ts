import { describe, expect, it, vi } from 'vitest';

import type { ContainerEngine } from '../hosted/container.js';
import {
  isForkPullRequest,
  resolveReviewContainment,
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
});
