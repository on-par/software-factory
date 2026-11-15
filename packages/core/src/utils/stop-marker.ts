import { readFileSync, statSync } from 'node:fs';

export type StopSource = 'manual' | 'usage-watchdog' | 'self-update' | 'unknown';

export interface StopMarker {
  source: StopSource;
  at?: string;
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

export function readStopMarker(path: string, deps: Partial<StopMarkerDeps> = {}): StopMarker | null {
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf-8'));
  const statMtimeMs = deps.statMtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  let content = '';
  let readError: string | undefined;
  try {
    content = readFile(path);
  } catch (err) {
    if (isEnoent(err)) return null;
    readError = `unreadable: ${(err as NodeJS.ErrnoException).code ?? String(err)}`;
  }
  const mtimeIso = (): string | null | undefined => {
    try {
      return new Date(statMtimeMs(path)).toISOString();
    } catch (err) {
      if (isEnoent(err)) return null;
      return undefined;
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
      return {
        source,
        ...(at !== undefined ? { at } : {}),
        ...(typeof rec.detail === 'string' ? { detail: rec.detail } : {}),
      };
    }
  }
  const at = mtimeIso();
  if (at === null) return null;
  return { source: 'unknown', ...(at !== undefined ? { at } : {}), ...(readError ? { detail: readError } : {}) };
}
