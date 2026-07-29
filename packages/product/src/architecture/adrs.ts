// packages/product/src/architecture/adrs.ts — minimal Accepted-ADR reader for the epic designer (#477).
import { formatAdrNumber, normalizeStatus, tryParseAdr } from '@on-par/adr-kit';
import type { RepoContextReader } from '@on-par/repo-context';

/** Repo-root-relative ADR home scanned by default — matches adr-home.ts's ADR_HOME_DIR. */
export const DEFAULT_ADR_DIR = 'docs/adr';

/** An Accepted ADR read from the target repo, condensed to what the epic designer needs. */
export interface EpicAdr {
  /** 'ADR-0004' when numbered, else the repo-relative path. */
  label: string;
  number: number | undefined;
  title: string;
  /** Repo-root-relative path, e.g. 'docs/adr/0004-narrow-public-core-api.md'. */
  path: string;
  /** Raw Decision section text as written. */
  decision: string;
}

const NON_ADR_FILENAME = /^(readme|index|_?template)\.md$/i;

export async function readActiveAdrs(reader: RepoContextReader, opts?: { dir?: string }): Promise<readonly EpicAdr[]> {
  const dir = opts?.dir ?? DEFAULT_ADR_DIR;

  const entries = await reader.readDir(dir);
  const candidates = entries.filter(
    (entry) => entry.type === 'file' && /\.md$/i.test(entry.name) && !NON_ADR_FILENAME.test(entry.name),
  );

  const active: EpicAdr[] = [];

  for (const entry of candidates) {
    const file = await reader.readFile(entry.path);
    if (file === undefined) {
      continue;
    }

    const result = tryParseAdr(file.text, { filename: entry.name });
    if (!result.ok) {
      continue;
    }

    if (normalizeStatus(result.adr.status) !== 'Accepted') {
      continue;
    }

    active.push({
      label: result.adr.number === undefined ? entry.path : `ADR-${formatAdrNumber(result.adr.number)}`,
      number: result.adr.number,
      title: result.adr.title,
      path: entry.path,
      decision: result.adr.decision,
    });
  }

  active.sort((a, b) => {
    if (a.number === undefined && b.number === undefined) return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    if (a.number === undefined) return 1;
    if (b.number === undefined) return -1;
    if (a.number !== b.number) return a.number - b.number;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return active;
}
