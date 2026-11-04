// packages/core/src/work/linear-issue.ts — read-only Linear issue input-source adapter (#3889).

import { extractAcceptanceCriteria } from './acceptance.js';
import { InvalidWorkRequestInputError, type WorkRequest, type WorkSourceAdapter } from './index.js';
import { createLinearClient } from './linear-client.js';
import { toWorkKey } from './work-key.js';

export const LINEAR_ISSUE_SOURCE = 'linear-issue';

const EXPECTED_FORM =
  'expected a Linear issue key like "ON-12" or a URL like https://linear.app/<workspace>/issue/ON-12';
const KEY_RE = /^[A-Za-z][A-Za-z0-9]*-[1-9]\d*$/;
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled']);

export interface LinearIssueSourceDeps {
  fetch?: typeof globalThis.fetch;
  env?: Readonly<Record<string, string | undefined>>;
  endpoint?: string;
}

function usageError(input: string): InvalidWorkRequestInputError {
  const shown = input.length > 200 ? `${input.slice(0, 200)}…` : input;
  return new InvalidWorkRequestInputError(LINEAR_ISSUE_SOURCE, `${EXPECTED_FORM}, got "${shown}"`);
}

/** Turns "ON-12" or a linear.app issue URL into the upper-cased issue key. */
export function parseLinearIssueRef(input: string): string {
  const trimmed = input.trim();
  if (KEY_RE.test(trimmed)) return trimmed.toUpperCase();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw usageError(trimmed);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'linear.app') throw usageError(trimmed);
  const [workspace, segment, key] = url.pathname.split('/').filter((s) => s !== '');
  if (!workspace || segment !== 'issue' || key === undefined || !KEY_RE.test(key)) throw usageError(trimmed);
  return key.toUpperCase();
}

function rawRef(params: unknown): string | undefined {
  if (typeof params === 'string') return params;
  if (typeof params === 'object' && params !== null && 'ref' in params && typeof params.ref === 'string') {
    return params.ref;
  }
  return undefined;
}

export function createLinearIssueAdapter(deps: LinearIssueSourceDeps = {}): WorkSourceAdapter {
  return {
    kind: LINEAR_ISSUE_SOURCE,
    async resolve(params): Promise<WorkRequest> {
      const raw = rawRef(params);
      if (raw === undefined) {
        throw new InvalidWorkRequestInputError(LINEAR_ISSUE_SOURCE, EXPECTED_FORM);
      }
      const ref = parseLinearIssueRef(raw);
      const apiKey = (deps.env ?? process.env).LINEAR_API_KEY?.trim();
      if (!apiKey) {
        throw new Error('LINEAR_API_KEY is not set — export a Linear personal API key to resolve Linear issues');
      }
      const issue = await createLinearClient({ apiKey, fetch: deps.fetch, endpoint: deps.endpoint }).fetchIssue(ref);
      return {
        id: `${LINEAR_ISSUE_SOURCE}:${issue.identifier}`,
        kind: LINEAR_ISSUE_SOURCE,
        key: toWorkKey(issue.identifier),
        title: issue.title,
        brief: issue.description,
        acceptanceCriteria: extractAcceptanceCriteria(issue.description),
        state: CLOSED_STATE_TYPES.has(issue.stateType) ? 'closed' : 'open',
        labels: issue.labels,
        reference: { externalId: issue.id, url: issue.url },
      };
    },
  };
}
