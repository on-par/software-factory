// src/hosted/authority.ts — Defines and proves the provider-session authority
// bundle shape for hosted jobs that need long-lived provider credentials
// (Codex OAuth, Claude Code OAuth, OpenCode Go OAuth, pi.dev) inside a
// disposable container (#906, parent #895). All resolve/mount/unmount effects
// sit behind the injected AuthorityBroker/AuthorityMountEngine ports so the
// orchestrator is hermetic and testable with fakes, mirroring how
// runContainerJob uses ContainerEngine; the real broker/mount adapter is a
// follow-up. withAuthority fails closed before mounting whenever the bundle
// is absent, invalid, unsupported, or unresolvable, and always unmounts in a
// finally so provider session material never becomes ambient runner state.
import { ProviderSessionBundleSchema, type ProviderKind, type ProviderSessionBundle } from '@on-par/contracts';

/** The mask written wherever a secret value would otherwise appear. */
export const AUTHORITY_REDACTION_MASK = '***';

/** A resolved secret — real material, held only transiently. Never persisted,
 * never returned in an outcome, never logged unmasked. */
export interface ResolvedSecret {
  name: string;
  value: string;
}

export interface AuthorityBroker {
  /** Resolves a bundle's opaque secret refs to real material. Throws when a ref
   * cannot be resolved (drives fail-closed). */
  resolve(bundle: ProviderSessionBundle): Promise<ResolvedSecret[]>;
}

export interface AuthorityMount {
  provider: ProviderKind;
  jobId: string;
  /** Absolute host path holding materialized session material for this job. */
  hostPath: string;
  /** Mount target inside the container (bundle.mountPath). */
  mountPath: string;
}

export interface AuthorityCleanupProof {
  hostPath: string;
  removed: boolean;
  /** Audit evidence string, e.g. 'unmounted /tmp/sf-auth-job-1'. */
  evidence: string;
}

export interface AuthorityMountEngine {
  mount(bundle: ProviderSessionBundle, secrets: ResolvedSecret[]): Promise<AuthorityMount>;
  unmount(mount: AuthorityMount): Promise<AuthorityCleanupProof>;
}

export interface PrepareAuthorityConfig {
  jobId: string;
  /** Providers this runner can mount; a bundle outside this set fails closed. */
  supported: ReadonlySet<ProviderKind>;
}

export type AuthorityFailure =
  | { reason: 'absent'; detail: string }
  | { reason: 'invalid'; detail: string }
  | { reason: 'unsupported'; detail: string }
  | { reason: 'resolve-failed'; detail: string };

export interface AuthorityRunOutcome<T> {
  ok: boolean;
  /** True iff use() was invoked (authority granted). */
  used: boolean;
  failure?: AuthorityFailure;
  value?: T;
  cleanup?: AuthorityCleanupProof;
  trace: string;
}

/** Replaces every occurrence of each non-empty resolved secret value with the
 * mask. Empty values are skipped so an empty secret can't blank the whole line. */
export function redactSecrets(text: string, secrets: ResolvedSecret[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.value.length > 0) out = out.split(s.value).join(AUTHORITY_REDACTION_MASK);
  }
  return out;
}

/** Drives resolve -> mount -> use -> unmount for a job's provider-session
 * authority. Fails closed (never mounts) when the bundle is absent, invalid,
 * unsupported by the runner, or the broker cannot resolve it. Once mounted,
 * always unmounts in a finally and surfaces the cleanup proof, even when
 * use() throws. No clock, no direct fs/network/child_process — all effects go
 * through the injected broker/engine. */
export async function withAuthority<T>(
  broker: AuthorityBroker,
  engine: AuthorityMountEngine,
  bundle: unknown,
  config: PrepareAuthorityConfig,
  use: (mount: AuthorityMount, redact: (text: string) => string) => Promise<T>,
): Promise<AuthorityRunOutcome<T>> {
  if (bundle === undefined || bundle === null) {
    return {
      ok: false,
      used: false,
      failure: { reason: 'absent', detail: 'no provider authority bundle supplied' },
      trace: 'authority absent -> fail closed',
    };
  }

  const parsed = ProviderSessionBundleSchema.safeParse(bundle);
  if (!parsed.success) {
    return {
      ok: false,
      used: false,
      failure: { reason: 'invalid', detail: parsed.error.message },
      trace: 'authority invalid -> fail closed',
    };
  }

  const b = parsed.data;
  if (!config.supported.has(b.provider)) {
    return {
      ok: false,
      used: false,
      failure: { reason: 'unsupported', detail: `provider ${b.provider} not supported by runner` },
      trace: 'authority unsupported -> fail closed',
    };
  }

  let secrets: ResolvedSecret[];
  try {
    secrets = await broker.resolve(b);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      used: false,
      failure: { reason: 'resolve-failed', detail: message },
      trace: 'authority resolve-failed -> fail closed',
    };
  }

  const mount = await engine.mount(b, secrets);
  const redact = (text: string) => redactSecrets(text, secrets);
  let value: T | undefined;
  let cleanup: AuthorityCleanupProof;
  try {
    value = await use(mount, redact);
  } finally {
    cleanup = await engine.unmount(mount);
  }
  return {
    ok: true,
    used: true,
    value,
    cleanup,
    trace: `authority ${b.provider} mounted -> used -> cleaned`,
  };
}
