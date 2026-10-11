// packages/cli/src/cli/self-update.ts — factory self-update --check (#2354)
import { Agent, request, type RequestOptions } from 'node:https';
import {
  DaemonCtlError,
  detectInstall,
  parseUpdateMode,
  updateChannel,
  type DetectInstallDeps,
  type InstallKind,
  type UpdateChannel,
} from './daemon.js';

export const PACKAGE_NAME = '@on-par/factory-cli';
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
export const DEFAULT_TIMEOUT_MS = 10_000;
export const EXIT_UP_TO_DATE = 0;
export const EXIT_UPDATE_AVAILABLE = 10;
export const EXIT_ERROR = 1;

/** One GET; resolves with status + body, rejects on network error or timeout. */
export type RegistryFetch = (url: string, opts: { timeoutMs: number }) => Promise<{ status: number; body: string }>;

export interface SelfUpdateDeps {
  fetch?: RegistryFetch;
  install?: DetectInstallDeps;
  registry?: string;
  timeoutMs?: number;
  out?: { write(s: string): unknown };
}

export interface SelfUpdateCheckResult {
  installKind: InstallKind;
  prefix: string;
  channel: UpdateChannel;
  current: string;
  candidate: string | null;
  updateAvailable: boolean;
  applies: boolean;
  error: string | null;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] === undefined ? [] : m[4].split('.'),
  };
}

/** SemVer 2.0.0 precedence; build metadata ignored. Throws on a malformed version. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa) throw new Error(`invalid version "${a}"`);
  if (!pb) throw new Error(`invalid version "${b}"`);
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    if (pa.prerelease.length === pb.prerelease.length) return 0;
    return pa.prerelease.length === 0 ? 1 : -1;
  }
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i]!;
    const y = pb.prerelease[i]!;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  if (pa.prerelease.length === pb.prerelease.length) return 0;
  return pa.prerelease.length < pb.prerelease.length ? -1 : 1;
}

export function selectCandidate(distTags: Record<string, string>, mode: 'stable' | 'prerelease'): string | null {
  if (mode === 'stable') {
    const v = distTags.latest;
    if (typeof v !== 'string') return null;
    const p = parseSemver(v);
    return p && p.prerelease.length === 0 ? v : null;
  }
  let best: string | null = null;
  for (const v of [distTags.next, distTags.latest]) {
    if (typeof v !== 'string' || !parseSemver(v)) continue;
    if (best === null || compareSemver(v, best) > 0) best = v;
  }
  return best;
}

/** The response surface `httpsRegistryFetch` reads; node's IncomingMessage satisfies it. */
export interface HttpsResponse {
  statusCode?: number;
  on(event: 'data', fn: (chunk: Buffer) => void): unknown;
  on(event: 'end', fn: () => void): unknown;
  on(event: 'error', fn: (err: Error) => void): unknown;
}

/** The slice of node:https `request` that `httpsRegistryFetch` uses. */
export type HttpsRequest = (
  url: string,
  options: RequestOptions,
  onResponse: (res: HttpsResponse) => void,
) => { on(event: 'error', fn: (err: Error) => void): unknown; end(): unknown };

/** A RegistryFetch over node:https that honours HTTPS_PROXY/NO_PROXY and aborts after `timeoutMs`. */
export function httpsRegistryFetch(requestImpl: HttpsRequest = request): RegistryFetch {
  return (url, { timeoutMs }) =>
    new Promise((resolve, reject) => {
      // proxyEnv exists from Node 24.5; older @types/node lacks it on AgentOptions.
      const agent = new Agent({ proxyEnv: process.env } as ConstructorParameters<typeof Agent>[0]);
      const req = requestImpl(
        url,
        { method: 'GET', headers: { accept: 'application/json' }, agent, signal: AbortSignal.timeout(timeoutMs) },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end();
    });
}

export async function fetchDistTags(
  fetchImpl: RegistryFetch,
  opts: { registry?: string; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
  const registry = (opts.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${registry}/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`;
  let res: { status: number; body: string };
  try {
    res = await fetchImpl(url, { timeoutMs });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`registry request timed out after ${timeoutMs} ms`);
    }
    throw err;
  }
  if (res.status < 200 || res.status > 299) throw new Error(`registry returned HTTP ${res.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error('registry returned malformed dist-tags');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((v) => typeof v === 'string')
  ) {
    throw new Error('registry returned malformed dist-tags');
  }
  return parsed as Record<string, string>;
}

export async function checkForUpdate(
  mode: 'stable' | 'prerelease',
  deps: SelfUpdateDeps = {},
): Promise<SelfUpdateCheckResult> {
  const install = detectInstall(deps.install);
  const channel = updateChannel(mode)!;
  const base = {
    installKind: install.kind,
    prefix: install.prefix,
    channel,
    current: install.version,
    applies: install.kind === 'npm-global',
  };
  try {
    const tags = await fetchDistTags(deps.fetch ?? httpsRegistryFetch(), {
      registry: deps.registry,
      timeoutMs: deps.timeoutMs,
    });
    const candidate = selectCandidate(tags, mode);
    const updateAvailable = candidate !== null && compareSemver(candidate, install.version) > 0;
    return { ...base, candidate, updateAvailable, error: null };
  } catch (err) {
    return {
      ...base,
      candidate: null,
      updateAvailable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function formatUpdateCheck(r: SelfUpdateCheckResult): string {
  if (r.error !== null) return `factory ${r.current}: update check failed (${r.channel}): ${r.error}`;
  if (r.updateAvailable) {
    const note = r.applies ? '' : `; not applied to a ${r.installKind} install`;
    return `factory ${r.current} → ${r.candidate} available on ${r.channel} (${r.installKind} install)${note}`;
  }
  return `factory ${r.current} is up to date on ${r.channel}`;
}

export async function cmdSelfUpdateCheck(
  opts: { json?: boolean; updateMode?: string },
  deps: SelfUpdateDeps = {},
): Promise<number> {
  const mode = parseUpdateMode(opts.updateMode ?? 'stable', '--update-mode');
  if (mode === 'manual') throw new DaemonCtlError('--check needs --update-mode stable or prerelease', 2);
  const result = await checkForUpdate(mode, deps);
  (deps.out ?? process.stdout).write(opts.json ? `${JSON.stringify(result)}\n` : `${formatUpdateCheck(result)}\n`);
  return result.error !== null ? EXIT_ERROR : result.updateAvailable ? EXIT_UPDATE_AVAILABLE : EXIT_UP_TO_DATE;
}
