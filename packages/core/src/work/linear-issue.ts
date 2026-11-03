// packages/core/src/work/linear-issue.ts — read-only Linear issue input-source adapter (#3889).
import { extractAcceptanceCriteria } from './acceptance.js';
import { InvalidWorkRequestInputError, type WorkRequest, type WorkSourceAdapter } from './index.js';
import type { LinearIssueClient } from './linear-client.js';
import { toWorkKey, type WorkKey } from './work-key.js';

export const LINEAR_ISSUE_SOURCE = 'linear-issue';

export interface LinearIssueParams {
  /** "ON-12" or https://linear.app/<workspace>/issue/ON-12[/slug] */
  input: string;
}

const EXPECTED_FORM = 'expected a Linear issue key like ON-12 or a URL like https://linear.app/<workspace>/issue/ON-12';
const KEY_RE = /^([A-Za-z][A-Za-z0-9]*)-([1-9]\d*)$/;
const CLOSED_STATE_TYPES: ReadonlySet<string> = new Set(['completed', 'canceled']);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function parseLinearIssueKey(input: string): WorkKey {
  const raw = input.trim();
  if (KEY_RE.test(raw)) return toWorkKey(raw.toUpperCase());
  const url = parseUrl(raw);
  if (url && url.protocol === 'https:' && url.hostname === 'linear.app') {
    const segments = url.pathname.split('/').filter((s) => s !== '');
    const candidate = segments[2];
    if (segments[1] === 'issue' && candidate !== undefined && KEY_RE.test(candidate)) {
      return toWorkKey(candidate.toUpperCase());
    }
  }
  throw new InvalidWorkRequestInputError(LINEAR_ISSUE_SOURCE, `"${raw}" is not a Linear issue — ${EXPECTED_FORM}`);
}

function isLinearIssueParams(params: unknown): params is LinearIssueParams {
  return typeof params === 'object' && params !== null && typeof (params as { input?: unknown }).input === 'string';
}

export function createLinearIssueAdapter(client: LinearIssueClient): WorkSourceAdapter {
  return {
    kind: LINEAR_ISSUE_SOURCE,
    async resolve(params: unknown): Promise<WorkRequest> {
      if (!isLinearIssueParams(params)) {
        throw new InvalidWorkRequestInputError(LINEAR_ISSUE_SOURCE, `expected { input: string } — ${EXPECTED_FORM}`);
      }
      const key = parseLinearIssueKey(params.input);
      const issue = await client.fetchIssue(key);
      const brief = issue.description ?? '';
      return {
        id: `${LINEAR_ISSUE_SOURCE}:${issue.identifier}`,
        kind: LINEAR_ISSUE_SOURCE,
        key: toWorkKey(issue.identifier),
        title: issue.title,
        brief,
        acceptanceCriteria: extractAcceptanceCriteria(brief),
        state: CLOSED_STATE_TYPES.has(issue.stateType) ? 'closed' : 'open',
        labels: issue.labels,
        reference: { externalId: issue.id, url: issue.url },
      } satisfies WorkRequest;
    },
  };
}
