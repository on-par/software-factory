// packages/core/src/queue/linear-queue.ts — Linear-backed queue seam: list and claimNext (ADR-0173, #3892).

import { z } from 'zod';
import { LinearApiError } from '../work/linear-client.js';
import type { LinearTrackerConfig } from '../config/tracker-section.js';
import { claimedByLabel, CLAIMED_BY_LABEL_PREFIX, defaultClaimantId, PARKED_LABEL } from './github-queue.js';
import { QUEUE_ORDER_LABEL_PREFIX } from './queue-order.js';
import type { QueueBackend, QueueBackendClaim } from './queue-backend.js';
import type { LinearClaimedIssue, LinearClaimLease, LinearQueueLifecycleClient } from './linear-queue-lifecycle.js';
import { toWorkKey, type WorkKey } from '../work/work-key.js';

export interface LinearQueueLabel {
  id: string;
  name: string;
  /** Parent label (group) name. */
  group?: string;
}
export interface LinearQueueIssue {
  id: string;
  identifier: string;
  priority: number;
  createdAt: string;
  stateType: string;
  labels: LinearQueueLabel[];
}
export interface LinearQueueClient {
  /** Issues in the mapped project, in the ready state, carrying the ready label. Rejects on any API error. */
  listCandidates(): Promise<LinearQueueIssue[]>;
  /** Fresh label names on one issue. */
  issueLabels(issueId: string): Promise<string[]>;
  /** Id of the team label `name`, creating it when missing. */
  ensureLabel(name: string): Promise<string>;
  addLabel(issueId: string, labelId: string): Promise<void>;
  removeLabel(issueId: string, labelId: string): Promise<void>;
  /** Moves the issue to the team workflow state named `stateName`. */
  moveToState(issueId: string, stateName: string): Promise<void>;
}
export type LinearQueue = Pick<QueueBackend, 'list' | 'claimNext' | 'lanes'>;
export interface LinearQueueOptions {
  client: LinearQueueClient;
  linear: LinearTrackerConfig;
  claimantId?: string;
  defaultLane?: string;
}

export const LINEAR_DEFAULT_LANE = 'default';
export const LINEAR_LEASE_ATTACHMENT_URL = 'https://github.com/on-par/software-factory#claim-lease';
const LINEAR_LEASE_TITLE = 'Factory claim lease';

const EXCLUDED_STATE_TYPES = new Set(['started', 'completed', 'canceled']);
const ORDER_PATTERN = new RegExp(`^${QUEUE_ORDER_LABEL_PREFIX}(\\d+)$`);

export function isLinearCandidate(issue: LinearQueueIssue, readyLabel: string): boolean {
  if (EXCLUDED_STATE_TYPES.has(issue.stateType)) return false;
  const names = issue.labels.map((l) => l.name);
  return (
    names.some((n) => n === readyLabel) &&
    !names.some((n) => n.startsWith(CLAIMED_BY_LABEL_PREFIX)) &&
    !names.includes(PARKED_LABEL)
  );
}

export function linearLaneOf(
  issue: LinearQueueIssue,
  laneLabelGroup: string,
  defaultLane: string = LINEAR_DEFAULT_LANE,
): string {
  return issue.labels.find((l) => l.group === laneLabelGroup)?.name ?? defaultLane;
}

function priorityRank(p: number): number {
  return p >= 1 && p <= 4 ? p : 5;
}

function orderOf(issue: LinearQueueIssue): number {
  const matches = issue.labels.map((l) => ORDER_PATTERN.exec(l.name)).filter((m) => m !== null);
  if (matches.length !== 1) return Number.POSITIVE_INFINITY;
  const n = Number(matches[0]?.[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
}

export function compareLinearCandidates(a: LinearQueueIssue, b: LinearQueueIssue): number {
  const pa = priorityRank(a.priority);
  const pb = priorityRank(b.priority);
  if (pa !== pb) return pa - pb;
  const oa = orderOf(a);
  const ob = orderOf(b);
  if (oa < ob) return -1;
  if (oa > ob) return 1;
  const ca = Date.parse(a.createdAt);
  const cb = Date.parse(b.createdAt);
  if (ca !== cb) return ca - cb;
  return a.identifier.localeCompare(b.identifier);
}

export function createLinearQueue(options: LinearQueueOptions): LinearQueue {
  const { client, linear } = options;
  const defaultLane = options.defaultLane ?? LINEAR_DEFAULT_LANE;
  const claimantId = options.claimantId ?? defaultClaimantId();
  const myLabel = claimedByLabel(claimantId);
  let myLabelId: string | undefined;

  const laneOf = (i: LinearQueueIssue): string => linearLaneOf(i, linear.laneLabelGroup, defaultLane);

  async function sortedFor(lane?: string): Promise<LinearQueueIssue[]> {
    const issues = await client.listCandidates();
    const eligible = issues.filter(
      (i) => isLinearCandidate(i, linear.readyLabel) && (lane === undefined || laneOf(i) === lane),
    );
    if (lane !== undefined) return eligible.sort(compareLinearCandidates);
    return eligible.sort((a, b) => laneOf(a).localeCompare(laneOf(b)) || compareLinearCandidates(a, b));
  }

  async function list(lane?: string): Promise<WorkKey[]> {
    return (await sortedFor(lane)).map((i) => toWorkKey(i.identifier));
  }

  async function lanes(): Promise<string[]> {
    return [...new Set((await sortedFor()).map(laneOf))].sort();
  }

  async function claimNext(lane: string): Promise<QueueBackendClaim | null> {
    const candidates = await sortedFor(lane);
    if (candidates.length === 0) return null;
    myLabelId ??= await client.ensureLabel(myLabel);
    for (const c of candidates) {
      await client.addLabel(c.id, myLabelId);
      await client.moveToState(c.id, linear.states.inProgress);
      const after = await client.issueLabels(c.id);
      const winner = after.filter((n) => n.startsWith(CLAIMED_BY_LABEL_PREFIX)).sort()[0];
      if (winner === myLabel) return { key: toWorkKey(c.identifier), decision: { kind: 'build' } };
      // The winner owns In Progress, so the state is left alone.
      if (after.includes(myLabel)) await client.removeLabel(c.id, myLabelId);
    }
    return null;
  }

  return { list, claimNext, lanes };
}

const MAX_PAGES = 10;

const ENVELOPE = z.object({
  data: z.unknown().nullish(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const CANDIDATES_QUERY = `query($after: String, $team: String!, $project: String!, $ready: String!, $label: String!) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, project: { or: [{ name: { eq: $project } }, { id: { eq: $project } }] }, state: { name: { eq: $ready } }, labels: { some: { name: { eq: $label } } } }) {
    nodes { id identifier priority createdAt state { type } labels { nodes { id name parent { name } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const ISSUE_FIELDS = `id identifier labels { nodes { id name } } attachments(filter: { url: { eq: $url } }) { nodes { id metadata } }`;
const FIND_ISSUE_QUERY = `query($id: String!, $url: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
const LEASED_QUERY = `query($after: String, $team: String!, $project: String!, $url: String!) {
  issues(first: 100, after: $after, filter: { team: { key: { eq: $team } }, project: { or: [{ name: { eq: $project } }, { id: { eq: $project } }] }, attachments: { some: { url: { eq: $url } } } }) {
    nodes { ${ISSUE_FIELDS} }
    pageInfo { hasNextPage endCursor }
  }
}`;
const COMMENT_MUTATION = `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
const UPSERT_ATTACHMENT_MUTATION = `mutation($issueId: String!, $title: String!, $url: String!, $metadata: JSONObject!) { attachmentCreate(input: { issueId: $issueId, title: $title, url: $url, metadata: $metadata }) { success } }`;
const DELETE_ATTACHMENT_MUTATION = `mutation($id: String!) { attachmentDelete(id: $id) { success } }`;
const TEAM_QUERY = `query($team: String!) { teams(filter: { key: { eq: $team } }) { nodes { id states { nodes { id name } } } } }`;
const FIND_LABEL_QUERY = `query($name: String!, $teamId: ID!) { issueLabels(filter: { name: { eq: $name }, team: { id: { eq: $teamId } } }) { nodes { id } } }`;
const CREATE_LABEL_MUTATION = `mutation($name: String!, $teamId: String!) { issueLabelCreate(input: { name: $name, teamId: $teamId }) { success issueLabel { id } } }`;
const ADD_LABEL_MUTATION = `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`;
const REMOVE_LABEL_MUTATION = `mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`;
const UPDATE_STATE_MUTATION = `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
const ISSUE_LABELS_QUERY = `query($id: String!) { issue(id: $id) { labels { nodes { name } } } }`;

const CandidatesSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        priority: z.number(),
        createdAt: z.string(),
        state: z.object({ type: z.string() }),
        labels: z.object({
          nodes: z.array(
            z.object({ id: z.string(), name: z.string(), parent: z.object({ name: z.string() }).nullish() }),
          ),
        }),
      }),
    ),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});
const ClaimedIssueNode = z.object({
  id: z.string(),
  identifier: z.string(),
  labels: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
  attachments: z.object({ nodes: z.array(z.object({ id: z.string(), metadata: z.unknown() })) }),
});
const FindIssueSchema = z.object({ issue: ClaimedIssueNode.nullable() });
const LeasedSchema = z.object({
  issues: z.object({
    nodes: z.array(ClaimedIssueNode),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullish() }),
  }),
});
const CommentSchema = z.object({ commentCreate: z.object({ success: z.boolean() }) });
const UpsertAttachmentSchema = z.object({ attachmentCreate: z.object({ success: z.boolean() }) });
const DeleteAttachmentSchema = z.object({ attachmentDelete: z.object({ success: z.boolean() }) });
const TeamSchema = z.object({
  teams: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        states: z.object({ nodes: z.array(z.object({ id: z.string(), name: z.string() })) }),
      }),
    ),
  }),
});
const FindLabelSchema = z.object({ issueLabels: z.object({ nodes: z.array(z.object({ id: z.string() })) }) });
const CreateLabelSchema = z.object({
  issueLabelCreate: z.object({ success: z.boolean(), issueLabel: z.object({ id: z.string() }).nullish() }),
});
const AddLabelSchema = z.object({ issueAddLabel: z.object({ success: z.boolean() }) });
const RemoveLabelSchema = z.object({ issueRemoveLabel: z.object({ success: z.boolean() }) });
const UpdateSchema = z.object({ issueUpdate: z.object({ success: z.boolean() }) });
const IssueLabelsSchema = z.object({
  issue: z.object({ labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }) }).nullable(),
});

export function createLinearQueueGraphqlClient(opts: {
  apiKey: string;
  linear: LinearTrackerConfig;
  project: string;
  fetch?: typeof globalThis.fetch;
  endpoint?: string;
  timeoutMs?: number;
}): LinearQueueClient & LinearQueueLifecycleClient {
  const { apiKey, linear, project } = opts;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? 'https://api.linear.app/graphql';
  const redact = (text: string): string => text.split(apiKey).join('***');

  async function request<T>(query: string, variables: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    let res: Response;
    let json: unknown;
    try {
      res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) throw new LinearApiError(`Linear API returned HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      if (err instanceof LinearApiError) throw err;
      throw new LinearApiError(redact(err instanceof Error ? err.message : String(err)));
    }
    const envelope = ENVELOPE.safeParse(json);
    if (!envelope.success) throw malformed(envelope.error);
    const { data, errors } = envelope.data;
    if (errors && errors.length > 0) {
      throw new LinearApiError(redact(`Linear API error: ${errors.map((e) => e.message).join('; ')}`));
    }
    if (data == null) throw new LinearApiError('Linear API returned no data');
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw malformed(parsed.error);
    return parsed.data;
  }

  function malformed(error: z.ZodError): LinearApiError {
    const first = error.issues[0];
    const where = first ? `${first.path.join('.')}: ${first.message}` : 'unknown';
    return new LinearApiError(redact(`malformed Linear response: ${where}`));
  }

  let team: Promise<z.infer<typeof TeamSchema>['teams']['nodes'][number]> | undefined;
  function teamInfo(): Promise<z.infer<typeof TeamSchema>['teams']['nodes'][number]> {
    team ??= request(TEAM_QUERY, { team: linear.teamKey }, TeamSchema).then((d) => {
      const found = d.teams.nodes[0];
      if (!found) throw new LinearApiError(`Linear team ${linear.teamKey} not found`);
      return found;
    });
    team.catch(() => {
      team = undefined;
    });
    return team;
  }

  function ensureSuccess(ok: boolean, what: string): void {
    if (!ok) throw new LinearApiError(`Linear ${what} reported success=false`);
  }

  function toClaimed(n: z.infer<typeof ClaimedIssueNode>): LinearClaimedIssue {
    const att = n.attachments.nodes[0];
    return {
      id: n.id,
      identifier: n.identifier,
      labels: n.labels.nodes,
      ...(att ? { lease: { attachmentId: att.id, metadata: att.metadata } } : {}),
    };
  }

  return {
    async findIssue(identifier) {
      let d: z.infer<typeof FindIssueSchema>;
      try {
        d = await request(FIND_ISSUE_QUERY, { id: identifier, url: LINEAR_LEASE_ATTACHMENT_URL }, FindIssueSchema);
      } catch (err) {
        if (err instanceof LinearApiError && /not found/i.test(err.message)) return null;
        throw err;
      }
      return d.issue ? toClaimed(d.issue) : null;
    },
    async listLeasedIssues() {
      const out: LinearClaimedIssue[] = [];
      let after: string | null = null as string | null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { issues }: z.infer<typeof LeasedSchema> = await request(
          LEASED_QUERY,
          { after, team: linear.teamKey, project, url: LINEAR_LEASE_ATTACHMENT_URL },
          LeasedSchema,
        );
        out.push(...issues.nodes.map(toClaimed));
        if (!issues.pageInfo.hasNextPage) return out;
        after = issues.pageInfo.endCursor ?? null;
      }
      throw new LinearApiError('Linear leased issues exceed 1000 issues');
    },
    async addComment(issueId, body) {
      const d = await request(COMMENT_MUTATION, { issueId, body }, CommentSchema);
      ensureSuccess(d.commentCreate.success, 'comment create');
    },
    async upsertLeaseAttachment(issueId, lease: LinearClaimLease) {
      const d = await request(
        UPSERT_ATTACHMENT_MUTATION,
        { issueId, title: LINEAR_LEASE_TITLE, url: LINEAR_LEASE_ATTACHMENT_URL, metadata: lease },
        UpsertAttachmentSchema,
      );
      ensureSuccess(d.attachmentCreate.success, 'attachment upsert');
    },
    async deleteAttachment(id) {
      const d = await request(DELETE_ATTACHMENT_MUTATION, { id }, DeleteAttachmentSchema);
      ensureSuccess(d.attachmentDelete.success, 'attachment delete');
    },
    async listCandidates() {
      const out: LinearQueueIssue[] = [];
      let after: string | null = null as string | null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const { issues }: z.infer<typeof CandidatesSchema> = await request(
          CANDIDATES_QUERY,
          { after, team: linear.teamKey, project, ready: linear.states.ready, label: linear.readyLabel },
          CandidatesSchema,
        );
        for (const n of issues.nodes) {
          out.push({
            id: n.id,
            identifier: n.identifier,
            priority: n.priority,
            createdAt: n.createdAt,
            stateType: n.state.type,
            labels: n.labels.nodes.map((l) => ({
              id: l.id,
              name: l.name,
              ...(l.parent ? { group: l.parent.name } : {}),
            })),
          });
        }
        if (!issues.pageInfo.hasNextPage) return out;
        after = issues.pageInfo.endCursor ?? null;
      }
      throw new LinearApiError('Linear ready queue exceeds 1000 issues');
    },
    async issueLabels(issueId) {
      const d = await request(ISSUE_LABELS_QUERY, { id: issueId }, IssueLabelsSchema);
      if (d.issue === null) throw new LinearApiError(`Linear issue ${issueId} not found`);
      return d.issue.labels.nodes.map((l) => l.name);
    },
    async ensureLabel(name) {
      const { id: teamId } = await teamInfo();
      const found = await request(FIND_LABEL_QUERY, { name, teamId }, FindLabelSchema);
      const existing = found.issueLabels.nodes[0];
      if (existing) return existing.id;
      const created = (await request(CREATE_LABEL_MUTATION, { name, teamId }, CreateLabelSchema)).issueLabelCreate;
      ensureSuccess(created.success, 'label create');
      if (!created.issueLabel) throw new LinearApiError('Linear label create returned no label');
      return created.issueLabel.id;
    },
    async addLabel(issueId, labelId) {
      const d = await request(ADD_LABEL_MUTATION, { id: issueId, labelId }, AddLabelSchema);
      ensureSuccess(d.issueAddLabel.success, 'label add');
    },
    async removeLabel(issueId, labelId) {
      const d = await request(REMOVE_LABEL_MUTATION, { id: issueId, labelId }, RemoveLabelSchema);
      ensureSuccess(d.issueRemoveLabel.success, 'label remove');
    },
    async moveToState(issueId, stateName) {
      const info = await teamInfo();
      const state = info.states.nodes.find((s) => s.name === stateName);
      if (!state) throw new LinearApiError(`Linear state "${stateName}" not found in team ${linear.teamKey}`);
      const d = await request(UPDATE_STATE_MUTATION, { id: issueId, stateId: state.id }, UpdateSchema);
      ensureSuccess(d.issueUpdate.success, 'state update');
    },
  };
}
