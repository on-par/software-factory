// src/router/ollama-probe.ts — Once-per-process reachability probe for the Ollama endpoint
import type { FetchFn } from './index.js';

export type OllamaProbeResult =
  { reachable: true; endpoint: string } | { reachable: false; endpoint: string; reason: string };

const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const probes = new Map<string, Promise<OllamaProbeResult>>();
let skipNoticeClaimed = false;

export function ollamaEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
}

async function runProbe(fetchFn: FetchFn, endpoint: string, timeoutMs: number): Promise<OllamaProbeResult> {
  try {
    const res = await fetchFn(`${endpoint}/api/version`, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { reachable: true, endpoint };
    return { reachable: false, endpoint, reason: `HTTP ${res.status}` };
  } catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string } } | null;
    const reason =
      e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : (e?.cause?.code ?? e?.message ?? String(err));
    return { reachable: false, endpoint, reason };
  }
}

/** Probe GET <endpoint>/api/version. Cached per endpoint for the process; never rejects. */
export function probeOllama(
  fetchFn: FetchFn,
  endpoint: string = ollamaEndpoint(),
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<OllamaProbeResult> {
  const cached = probes.get(endpoint);
  if (cached) return cached;
  const probe = runProbe(fetchFn, endpoint, timeoutMs);
  probes.set(endpoint, probe);
  return probe;
}

/** True only the first time per process, gating the single skip log line. */
export function claimOllamaSkipNotice(): boolean {
  const first = !skipNoticeClaimed;
  skipNoticeClaimed = true;
  return first;
}

/** Test-only: clear the probe cache and skip-notice latch. */
export function resetOllamaProbeCache(): void {
  probes.clear();
  skipNoticeClaimed = false;
}
