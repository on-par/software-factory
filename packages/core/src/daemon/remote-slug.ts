// src/daemon/remote-slug.ts — Pure `owner/name` parser for a git remote URL.
// Factored out of daemon/repos-attach.ts (#971) so the synchronous logger path
// (logger/repo-slug.ts) can import just this parsing logic without pulling
// repos-attach.ts's own imports — `execa` via utils/command-runner.ts, and the
// repo registry — into every module that constructs a FactoryLogger. This file
// has zero imports by design; keep it that way.

/** Pure: `owner/name` from a git remote URL, host-agnostic (the slug is just
 *  the last two path segments), or null when it does not parse. Handles both
 *  scp-style (`git@host:owner/name.git`) and URL-style
 *  (`https://host/owner/name`, `ssh://git@host/owner/name.git`) remotes. */
export function parseRemoteSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let pathPart: string;
  if (trimmed.includes('://')) {
    const afterScheme = trimmed.split('://')[1] ?? '';
    const slashIndex = afterScheme.indexOf('/');
    if (slashIndex === -1) return null;
    pathPart = afterScheme.slice(slashIndex + 1);
  } else if (trimmed.includes(':')) {
    pathPart = trimmed.slice(trimmed.indexOf(':') + 1);
  } else {
    return null;
  }

  while (pathPart.endsWith('/')) pathPart = pathPart.slice(0, -1);
  if (pathPart.endsWith('.git')) pathPart = pathPart.slice(0, -4);
  const segments = pathPart.split('/').filter((s) => s.length > 0);
  if (segments.length !== 2) return null;
  return `${segments[0]}/${segments[1]}`;
}
