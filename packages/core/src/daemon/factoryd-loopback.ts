// The loopback rule for factoryd's bind host, split from factoryd-http.ts (max-lines).

/** The only hosts factoryd may bind: binding loopback IS its authorization model (ADR-0034). */
export const FACTORYD_LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

/** Single owner of the loopback rule. Throws before any bind for a non-loopback host. */
export function assertFactorydLoopbackHost(host: string): void {
  if (FACTORYD_LOOPBACK_HOSTS.includes(host)) return;
  throw new Error(
    `factoryd refuses to bind non-loopback host ${JSON.stringify(host)}: its HTTP API has no authentication ` +
      `and is authorized by its loopback binding alone (ADR-0034). Set FACTORYD_HOST to 127.0.0.1, localhost ` +
      `or ::1 (in Docker use network_mode: host); remote access needs a new ADR with real authentication.`,
  );
}
