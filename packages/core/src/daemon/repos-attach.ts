// src/daemon/repos-attach.ts — The registry-writing step on top of factoryd's
// checkout precondition gate in checkout-validation.ts. Once validation has
// passed, it writes the checkout into ~/.factory/registry.json. A rejected
// attach never touches the registry file (#778, #1398, epic #761).

import {
  type CheckoutValidationDeps,
  type CheckoutValidationFailureReason,
  validateCheckout,
} from './checkout-validation.js';
import { loadRegistry, type RepoRegistryListing, upsertRepo, writeRegistry } from './registry.js';

export { parseRemoteSlug } from './remote-slug.js';
export { readOriginUrl } from './checkout-validation.js';

export type AttachFailureReason = CheckoutValidationFailureReason;

export type AttachRepoResult =
  { ok: true; entry: RepoRegistryListing } | { ok: false; reason: AttachFailureReason; detail: string };

/** Injectable seams — production callers pass nothing. They exist so the HTTP
 *  suite never has to build a real checkout and so attachedAt is deterministic. */
export interface AttachRepoDeps {
  readOrigin?: (dir: string) => Promise<string | null>;
  fileExists?: (file: string) => Promise<boolean>;
  now?: () => Date;
}

export async function attachRepo(
  registryFile: string,
  body: unknown,
  deps: AttachRepoDeps = {},
): Promise<AttachRepoResult> {
  const validation = await validateCheckout(body, deps satisfies CheckoutValidationDeps);
  if (!validation.ok) return { ok: false, reason: validation.reason, detail: validation.detail };

  const { repo, dir } = validation.checkout;
  const attachedAt = (deps.now?.() ?? new Date()).toISOString();
  const entry = { path: dir, attachedAt, state: 'active' as const };
  const registry = await loadRegistry(registryFile);
  await writeRegistry(registryFile, upsertRepo(registry, repo, entry));

  return { ok: true, entry: { slug: repo, ...entry } };
}
