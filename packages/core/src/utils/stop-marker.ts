// STOP-file source marker (#3209): a one-line JSON body naming who set the STOP.
import { readFileSync, statSync } from 'node:fs';

export type StopSource = 'manual' | 'usage-watchdog' | 'self-update' | 'unknown';

export interface StopMarker {
  source: StopSource;
  at: string;
  detail?: string;
}

export interface StopMarkerDeps {
  readFile: (path: string) => string;
  statMtimeMs: (path: string) => number;
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set(['manual', 'usage-watchdog', 'self-update']);

export function formatStopMarker(source: Exclude<StopSource, 'unknown'>, at = new Date(), detail?: string): string {
  return `${JSON.stringify({ source, at: at.toISOString(), ...(detail ? { detail } : {}) })}\n`;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/** Reads the STOP marker. Null when the file is absent; `unknown` source for empty, legacy or unparsable content. */
export function readStopMarker(path: string, deps: Partial<StopMarkerDeps> = {}): StopMarker | null {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const statMtimeMs = deps.statMtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  let content = '';
  try {
    content = readFile(path);
  } catch (err) {
    if (isEnoent(err)) return null;
  }
  const mtimeIso = (): string | null => {
    try {
      return new Date(statMtimeMs(path)).toISOString();
    } catch (err) {
      if (isEnoent(err)) return null;
      return new Date(0).toISOString();
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.source === 'string' && KNOWN_SOURCES.has(rec.source)) {
      const source = rec.source as Exclude<StopSource, 'unknown'>;
      const at = typeof rec.at === 'string' && Number.isFinite(Date.parse(rec.at)) ? rec.at : mtimeIso();
      if (at === null) return null;
      return { source, at, ...(typeof rec.detail === 'string' ? { detail: rec.detail } : {}) };
    }
  }
  const at = mtimeIso();
  if (at === null) return null;
  return { source: 'unknown', at };
}
