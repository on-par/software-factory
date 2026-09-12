// src/daemon/checkout-validation.ts — factoryd's checkout precondition gate:
// validates a `{ repo, path }` request against the checkout on disk (its git
// origin remote must resolve to the posted slug, and it must carry
// .factory/config.json), with no registry access. Factored out of
// repos-attach.ts so callers can ask for a verdict without risking a registry
// write (#1398, epic #1380).

import { stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

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
  /** Absolute path of the `.factory/config.json` that was found. */
  configFile: string;
}

export type CheckoutValidationResult =
  { ok: true; checkout: ValidatedCheckout } | { ok: false; reason: CheckoutValidationFailureReason; detail: string };

/** Injectable seams — production callers pass nothing. They exist so suites never
 *  have to build a real checkout on disk. */
export interface CheckoutValidationDeps {
  readOrigin?: (dir: string) => Promise<string | null>;
  fileExists?: (file: string) => Promise<boolean>;
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
): { ok: true; request: { repo: string; path: string } } | { ok: false; detail: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  const { repo, path } = body as { repo?: unknown; path?: unknown };
  if (typeof repo !== 'string' || typeof path !== 'string') {
    return { ok: false, detail: 'expected { repo: "owner/name", path: "/abs/path" }' };
  }
  if (!SLUG_RE.test(repo)) {
    return { ok: false, detail: `repo must be an "owner/name" slug, got ${JSON.stringify(repo)}` };
  }
  if (!isAbsolute(path)) {
    return { ok: false, detail: 'path must be absolute' };
  }
  return { ok: true, request: { repo, path } };
}

/** The checkout precondition gate, with no registry access. */
export async function validateCheckout(
  body: unknown,
  deps: CheckoutValidationDeps = {},
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

  const configFile = join(dir, '.factory', 'config.json');
  const hasConfig = await (deps.fileExists ?? defaultFileExists)(configFile);
  if (!hasConfig) {
    return { ok: false, reason: 'missing-factory-config', detail: `${configFile} not found` };
  }

  return { ok: true, checkout: { repo: request.repo, dir, originSlug: slug, configFile } };
}
