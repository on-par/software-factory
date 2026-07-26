// src/path.ts — pure repo-path normalization (#468).

/**
 * Normalizes a repo-root-relative path: trims whitespace, collapses `//`, drops a leading
 * `/` or `./`, drops a trailing `/`, and maps '', '.', '/', './' to the repo root ''.
 * Returns `undefined` when any segment is `..` — the path would escape the repo root.
 */
export function normalizeRepoPath(path: string): string | undefined {
  const segments = path
    .trim()
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.');

  if (segments.some((segment) => segment === '..')) {
    return undefined;
  }

  return segments.join('/');
}

export function joinRepoPath(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`;
}
