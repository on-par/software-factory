// packages/core/src/work/local-brief.ts — local Markdown brief input-source adapter (#507).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractAcceptanceCriteria } from './acceptance.js';
import { InvalidWorkRequestInputError, type WorkRequest, type WorkSourceAdapter } from './index.js';

export const LOCAL_BRIEF_SOURCE = 'local-brief';

export interface LocalBriefParams {
  /** Path to the Markdown brief, as supplied by the caller (absolute or cwd-relative). */
  path: string;
}

/** File access seam so tests can inject content without touching disk. */
export interface BriefFileReader {
  readFile(absolutePath: string): Promise<string>;
}

export function createFsBriefReader(): BriefFileReader {
  return { readFile: (absolutePath) => readFile(absolutePath, 'utf-8') };
}

function isLocalBriefParams(params: unknown): params is LocalBriefParams {
  if (typeof params !== 'object' || params === null) return false;
  const { path } = params as { path?: unknown };
  return typeof path === 'string' && path.length > 0;
}

const TITLE_RE = /^#\s+(\S.*)$/m;

export function createLocalBriefAdapter(reader: BriefFileReader = createFsBriefReader()): WorkSourceAdapter {
  return {
    kind: LOCAL_BRIEF_SOURCE,
    async resolve(params: unknown): Promise<WorkRequest> {
      if (!isLocalBriefParams(params)) {
        throw new InvalidWorkRequestInputError(LOCAL_BRIEF_SOURCE, 'expected { path: "path/to/brief.md" }');
      }

      const content = await reader.readFile(resolve(params.path));
      const digest = createHash('sha256').update(content).digest('hex');

      const titleMatch = TITLE_RE.exec(content);
      if (!titleMatch) {
        throw new InvalidWorkRequestInputError(
          LOCAL_BRIEF_SOURCE,
          'brief has no title — start the document with a "# <title>" heading',
        );
      }
      const title = titleMatch[1].trim();

      const brief = content.slice(titleMatch.index + titleMatch[0].length).trim();
      if (brief.length === 0) {
        throw new InvalidWorkRequestInputError(
          LOCAL_BRIEF_SOURCE,
          'brief has no task content — describe the requested behavior below the title',
        );
      }

      const acceptanceCriteria = extractAcceptanceCriteria(brief);
      if (acceptanceCriteria.length === 0) {
        throw new InvalidWorkRequestInputError(
          LOCAL_BRIEF_SOURCE,
          'brief has no acceptance criteria — add an "## Acceptance criteria" section with at least one item',
        );
      }

      return {
        id: `${LOCAL_BRIEF_SOURCE}:${params.path}#${digest.slice(0, 12)}`,
        kind: LOCAL_BRIEF_SOURCE,
        title,
        brief,
        acceptanceCriteria,
        reference: {
          externalId: digest,
          url: pathToFileURL(resolve(params.path)).href,
        },
      } satisfies WorkRequest;
    },
  };
}
