/** `factory daemon attach|detach --json` payload (#2280). Additive changes only; bump schemaVersion on a breaking change. */
export interface DaemonRepoJson {
  schemaVersion: 1;
  ok: boolean;
  action: 'attach' | 'detach';
  /** null only when attach could not derive a slug. */
  repo: string | null;
  /** AttachFailureReason | 'unknown-repo' | 'daemon-unreachable' | 'unknown-failure' | a newer daemon's code. Present only when ok is false. */
  reason?: string;
}

export function buildDaemonRepoJson(input: {
  action: 'attach' | 'detach';
  repo: string | null;
  ok: boolean;
  reason?: string;
}): DaemonRepoJson {
  const base = { schemaVersion: 1 as const, ok: input.ok, action: input.action, repo: input.repo };
  return input.ok || input.reason === undefined ? base : { ...base, reason: input.reason };
}
