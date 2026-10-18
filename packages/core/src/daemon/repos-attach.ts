// src/daemon/repos-attach.ts — The registry-writing step on top of factoryd's
// checkout precondition gate in checkout-validation.ts. Once validation has
// passed, it writes the checkout into ~/.factory/registry.json. A rejected
// attach never touches the registry file (#778, #1398, epic #761). A re-attach
// of a live (active/paused) entry never changes its state, attachedAt or
// stateRoot; only a tombstone is revived by an attach (#3200, ADR-0036).

import {
  type CheckoutValidationDeps,
  type CheckoutValidationFailureReason,
  validateCheckout,
} from './checkout-validation.js';
import { getRepo, loadRegistry, type RepoRegistryListing, upsertRepo, writeRegistry } from './registry.js';

export { parseRemoteSlug } from './remote-slug.js';
export { readOriginUrl } from './checkout-validation.js';

export type AttachFailureReason = CheckoutValidationFailureReason | 'draining' | 'state-root-mismatch';

export type AttachRepoResult =
  | { ok: true; entry: RepoRegistryListing; created: true }
  | { ok: true; entry: RepoRegistryListing; created: false; changed: boolean }
  | { ok: false; reason: AttachFailureReason; detail: string };

/** Injectable seams — production callers pass nothing. They exist so the HTTP
 *  suite never has to build a real checkout and so attachedAt is deterministic. */
export interface AttachRepoDeps {
  readOrigin?: (dir: string) => Promise<string | null>;
  fileExists?: (file: string) => Promise<boolean>;
  now?: () => Date;
  home?: string;
}

export async function attachRepo(
  registryFile: string,
  body: unknown,
  deps: AttachRepoDeps = {},
): Promise<AttachRepoResult> {
  const registry = await loadRegistry(registryFile);
  const slugKey = (body as { repo?: unknown } | null)?.repo;
  const existingStateRoot = typeof slugKey === 'string' ? registry.repos[slugKey]?.stateRoot : undefined;
  const validation = await validateCheckout(body, deps satisfies CheckoutValidationDeps, existingStateRoot);
  if (!validation.ok) return { ok: false, reason: validation.reason, detail: validation.detail };

  const { repo, dir, stateRoot } = validation.checkout;
  const existing = getRepo(registry, repo);

  if (existing === undefined || existing.state === 'detached') {
    const attachedAt = (deps.now?.() ?? new Date()).toISOString();
    const entry = {
      path: dir,
      ...(stateRoot ? { stateRoot } : {}),
      attachedAt,
      state: 'active' as const,
    };
    await writeRegistry(registryFile, upsertRepo(registry, repo, entry));
    return { ok: true, entry: { slug: repo, ...entry }, created: true };
  }

  if (existing.state === 'draining') {
    return {
      ok: false,
      reason: 'draining',
      detail: `${repo} is draining; wait for the detach to finish before re-attaching`,
    };
  }
  if (stateRoot !== existing.stateRoot) {
    return {
      ok: false,
      reason: 'state-root-mismatch',
      detail: `${repo} is attached with stateRoot ${existing.stateRoot ?? '(none)'}; refusing to re-point it to ${stateRoot ?? '(none)'}`,
    };
  }
  if (existing.path === dir) {
    return { ok: true, entry: { slug: repo, ...existing }, created: false, changed: false };
  }
  const entry = { ...existing, path: dir };
  await writeRegistry(registryFile, upsertRepo(registry, repo, entry));
  return { ok: true, entry: { slug: repo, ...entry }, created: false, changed: true };
}
