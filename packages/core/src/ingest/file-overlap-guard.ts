// src/ingest/file-overlap-guard.ts — cheap file-name-overlap admission guard for
// auto-ingest (#1514). File-name overlap only, no semantic/LLM similarity: two ready
// issues in the same ingest cycle that name the same primary source file collide.

const SOURCE_FILE_EXTENSIONS =
  'tsx?|jsx?|mjs|cjs|py|go|rb|java|kt|rs|cc?|cpp|hh?|hpp|css|scss|less|html?|json|ya?ml|md|sql|sh';

const FILE_MENTION_RE = new RegExp(`(?:[\\w.-]+/)*[\\w-]+\\.(?:${SOURCE_FILE_EXTENSIONS})\\b`, 'gi');

/** Ubiquitous filenames too generic to imply two issues touch the same code. */
const GENERIC_FILE_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'readme.md',
  'changelog.md',
  'index.ts',
  'index.tsx',
  'index.js',
]);

export interface FileOverlapCandidate {
  number: number;
  title: string;
  body: string;
}

export interface FileOverlapMatch {
  /** The earlier candidate this one names the same primary file as. */
  number: number;
  title: string;
  /** The shared, lowercased basename that triggered the match. */
  path: string;
}

function primaryFileNames(candidate: FileOverlapCandidate): Set<string> {
  const text = `${candidate.title}\n${candidate.body}`;
  const matches = text.match(FILE_MENTION_RE) ?? [];
  const names = new Set<string>();
  for (const match of matches) {
    const basename = (match.includes('/') ? match.slice(match.lastIndexOf('/') + 1) : match).toLowerCase();
    if (!GENERIC_FILE_NAMES.has(basename)) names.add(basename);
  }
  return names;
}

/**
 * Scans candidates in list order. For each one, returns the earliest prior candidate
 * (by list position) that names the same primary file, if any. First mention of a file
 * name always wins the slot; every later candidate naming it collides with that first one.
 */
export function findFileOverlapCollisions(candidates: readonly FileOverlapCandidate[]): Map<number, FileOverlapMatch> {
  const collisions = new Map<number, FileOverlapMatch>();
  const firstNamedBy = new Map<string, FileOverlapCandidate>();

  for (const candidate of candidates) {
    for (const fileName of primaryFileNames(candidate)) {
      const earlier = firstNamedBy.get(fileName);
      if (earlier && earlier.number !== candidate.number && !collisions.has(candidate.number)) {
        collisions.set(candidate.number, { number: earlier.number, title: earlier.title, path: fileName });
      }
      if (!firstNamedBy.has(fileName)) firstNamedBy.set(fileName, candidate);
    }
  }

  return collisions;
}
