// src/daemon/checkout-validation.ts — factoryd's checkout precondition gate:
// validates a `{ repo, path }` request against the checkout on disk (its git
// origin remote must resolve to the posted slug, and it must carry
// .factory/config.json), with no registry access. Factored out of
// repos-attach.ts so callers can ask for a verdict without risking a registry
// write (#1398, epic #1380).

import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { resolveStateRoot } from '../config/state-root.js';
import { runCommand } from '../utils/command-runner.js';
import { parseRemoteSlug } from './remote-slug.js';

/** Failure reasons for the checkout precondition gate, in the order they are checked. */
export type CheckoutValidationFailureReason =
  'invalid-request' | 'not-a-git-checkout' | 'origin-mismatch' | 'missing-factory-config';

/** A checkout that passed every precondition. */
export interface ValidatedCheckout {
  /** The `owner/name` slug exactly as submitted (casing preserved). */
  repo: string;
  /** The submitted path, resolved to an absolute directory. */
  dir: string;
  /** The `owner/name` parsed from the checkout's git origin remote. */
  originSlug: string;
  /** Absolute path of the in-checkout `.factory/config.json`, or null when absent under a state root. */
  configFile: string | null;
  /** The resolved external state root, when one is in effect (from the request or the registry entry). */
  stateRoot?: string;
}

export type CheckoutValidationResult =
  { ok: true; checkout: ValidatedCheckout } | { ok: false; reason: CheckoutValidationFailureReason; detail: string };

/** Injectable seams — production callers pass nothing. They exist so suites never
 *  have to build a real checkout on disk. */
export interface CheckoutValidationDeps {
  readOrigin?: (dir: string) => Promise<string | null>;
  fileExists?: (file: string) => Promise<boolean>;
  /** Home directory used to resolve a `stateRoot` of `auto`. */
  home?: string;
}

const SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The default `readOrigin` seam: `git -C <dir> remote get-url origin`. Using
 *  `-C` rather than `cwd` means a nonexistent directory is a normal non-zero
 *  exit, not a spawn error. */
export async function readOriginUrl(dir: string): Promise<string | null> {
  const r = await runCommand(['git', '-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 });
  return r.ok ? r.stdout.trim() || null : null;
}

async function defaultFileExists(file: string): Promise<boolean> {
  return stat(file)
    .then((s) => s.isFile())
    .catch(() => false);
}

export function parseCheckoutRequest(
  body: unknown,
): { ok: true; request: { repo: string; path: string; stateRoot?: string } } | { ok: false; detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  const { repo, path, stateRoot } = body as { repo?: unknown; path?: unknown; stateRoot?: unknown };
  if (typeof repo !== 'string' || typeof path !== 'string') {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  if (!SLUG_RE.test(repo)) {
    return { ok: false, detail: `repo must be an "owner/name" slug, got ${JSON.stringify(repo)}` };
  }
  if (!isAbsolute(path)) {
    return { ok: false, detail: 'path must be absolute' };
  }
  if (stateRoot !== undefined) {
    if (typeof stateRoot !== 'string' || !(isAbsolute(stateRoot) || stateRoot.trim().toLowerCase() === 'auto')) {
      return { ok: false, detail: 'stateRoot must be an absolute path or "auto"' };
    }
    return { ok: true, request: { repo, path, stateRoot } };
  }
  return { ok: true, request: { repo, path } };
}

/** The checkout precondition gate, with no registry access. */
export async function validateCheckout(
  body: unknown,
  deps: CheckoutValidationDeps = {},
  existingStateRoot?: string,
): Promise<CheckoutValidationResult> {
  const parsed = parseCheckoutRequest(body);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalid-request', detail: parsed.detail };
  }
  const { request } = parsed;
  const dir = resolve(request.path);

  const origin = await (deps.readOrigin ?? readOriginUrl)(dir);
  if (origin === null) {
    return { ok: false, reason: 'not-a-git-checkout', detail: `${dir} is not a git checkout with an origin remote` };
  }

  const slug = parseRemoteSlug(origin);
  if (slug === null) {
    return {
      ok: false,
      reason: 'not-a-git-checkout',
      detail: `origin remote "${origin}" does not parse to owner/name`,
    };
  }

  if (slug.toLowerCase() !== request.repo.toLowerCase()) {
    return { ok: false, reason: 'origin-mismatch', detail: `origin is ${slug}, not ${request.repo}` };
  }

  const stateRoot =
    request.stateRoot !== undefined
      ? resolveStateRoot(request.stateRoot, { repoRoot: dir, home: deps.home, resolveSlug: () => slug })
      : existingStateRoot;
  const inCheckoutConfig = join(dir, '.factory', 'config.json');
  const hasConfig = await (deps.fileExists ?? defaultFileExists)(inCheckoutConfig);
  if (!hasConfig && stateRoot === undefined) {
    return { ok: false, reason: 'missing-factory-config', detail: `${inCheckoutConfig} not found` };
  }

  return {
    ok: true,
    checkout: {
      repo: request.repo,
      dir,
      originSlug: slug,
      configFile: hasConfig ? inCheckoutConfig : null,
      ...(stateRoot !== undefined ? { stateRoot } : {}),
    },
  };
}
