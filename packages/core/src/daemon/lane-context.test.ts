import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDaemonLaneContext } from './lane-context.js';
import type { RepoRegistryListing } from './registry.js';

const attachedAt = '2026-08-25T12:00:00.000Z';

describe('daemon state lane context', () => {
  it('keeps each checkout root while resolving state paths from its registered external root', () => {
    const alphaStateRoot = '/var/lib/factory-state/alpha';
    const betaStateRoot = '/var/lib/factory-state/beta';
    const alpha: RepoRegistryListing = {
      slug: 'on-par/alpha',
      path: '/worktrees/alpha',
      attachedAt,
      state: 'active',
      stateRoot: alphaStateRoot,
    };
    const beta: RepoRegistryListing = {
      slug: 'on-par/beta',
      path: '/worktrees/beta',
      attachedAt,
      state: 'active',
      stateRoot: betaStateRoot,
    };

    const alphaContext = createDaemonLaneContext(alpha);
    const betaContext = createDaemonLaneContext(beta);

    expect(alphaContext.repoRoot).toBe(alpha.path);
    expect(betaContext.repoRoot).toBe(beta.path);
    expect(alphaContext.paths.state).toBe(resolve(alphaStateRoot));
    expect(alphaContext.paths.plans).toBe(resolve(alphaStateRoot, 'plans'));
    expect(alphaContext.paths.events).toBe(resolve(alphaStateRoot, 'events.ndjson'));
    expect(betaContext.paths.state).toBe(resolve(betaStateRoot));
    expect(betaContext.paths.plans).toBe(resolve(betaStateRoot, 'plans'));
    expect(betaContext.paths.events).toBe(resolve(betaStateRoot, 'events.ndjson'));
    expect(Object.values(alphaContext.paths).every((path) => path.startsWith(resolve(alphaStateRoot)))).toBe(true);
    expect(Object.values(betaContext.paths).every((path) => path.startsWith(resolve(betaStateRoot)))).toBe(true);
    expect(Object.values(alphaContext.paths).every((path) => !path.startsWith(resolve(alpha.path, '.factory')))).toBe(
      true,
    );
    expect(Object.values(betaContext.paths).every((path) => !path.startsWith(resolve(beta.path, '.factory')))).toBe(
      true,
    );
    expect(Object.values(alphaContext.paths).every((path) => !path.startsWith(resolve(betaStateRoot)))).toBe(true);
    expect(Object.values(betaContext.paths).every((path) => !path.startsWith(resolve(alphaStateRoot)))).toBe(true);
  });

  it('uses the checkout-local .factory path when stateRoot is omitted', () => {
    const entry: RepoRegistryListing = {
      slug: 'on-par/legacy',
      path: '/worktrees/legacy',
      attachedAt,
      state: 'active',
    };

    const context = createDaemonLaneContext(entry);

    expect(context.repoRoot).toBe(entry.path);
    expect(context.paths.state).toBe(resolve(entry.path, '.factory'));
    expect(context.paths.plans).toBe(resolve(entry.path, '.factory', 'plans'));
    expect(context.paths.events).toBe(resolve(entry.path, '.factory', 'events.ndjson'));
  });
});
