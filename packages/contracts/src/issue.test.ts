import { describe, expect, it } from 'vitest';

import type { EngineeringReadyIssue, Epic, Story } from './issue.js';
import {
  CONTRACTS_SCHEMA_VERSION,
  EngineeringReadyIssueSchema,
  EpicSchema,
  IssueKindSchema,
  StorySchema,
} from './issue.js';
import { deserialize, serialize } from './serde.js';

const acceptanceCriterion = {
  name: 'Ships a green PR',
  given: ['a frozen spec'],
  when: ['the build phase runs'],
  then: ['CI is green'],
};

const verificationStep = { command: 'bash scripts/verify.sh', passWhen: 'all checks green' };

const baseIssue: EngineeringReadyIssue = {
  schemaVersion: CONTRACTS_SCHEMA_VERSION,
  kind: 'task' as const,
  title: 'Add the contracts package',
  problemStatement: 'There is no typed seam between proposer and writer apps.',
  inScope: ['packages/contracts'],
  outOfScope: ['proposer app'],
  acceptanceCriteria: [acceptanceCriterion],
  verification: [verificationStep],
  filesLikelyTouched: ['packages/contracts/src/index.ts'],
  labels: ['kernel'],
};

describe('IssueKindSchema', () => {
  it('accepts all four kinds', () => {
    for (const kind of ['epic', 'story', 'task', 'bug']) {
      expect(IssueKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('rejects an unknown kind', () => {
    expect(() => IssueKindSchema.parse('spike')).toThrow();
  });
});

describe('EngineeringReadyIssueSchema', () => {
  it('round-trips a fixture', () => {
    const raw = serialize(EngineeringReadyIssueSchema, baseIssue);
    expect(deserialize(EngineeringReadyIssueSchema, raw)).toEqual(baseIssue);
  });

  it('defaults schemaVersion when omitted from the input JSON', () => {
    const { schemaVersion, ...withoutVersion } = baseIssue;
    void schemaVersion;
    const parsed = EngineeringReadyIssueSchema.parse(JSON.parse(JSON.stringify(withoutVersion)));
    expect(parsed.schemaVersion).toBe(CONTRACTS_SCHEMA_VERSION);
  });

  it('rejects an empty inScope', () => {
    expect(() => EngineeringReadyIssueSchema.parse({ ...baseIssue, inScope: [] })).toThrow();
  });

  it('rejects an empty acceptanceCriteria', () => {
    expect(() => EngineeringReadyIssueSchema.parse({ ...baseIssue, acceptanceCriteria: [] })).toThrow();
  });
});

describe('StorySchema', () => {
  const story: Story = {
    ...baseIssue,
    kind: 'story' as const,
    role: 'factory operator',
    want: 'a typed contract package',
    soThat: 'proposer and writer apps share one schema',
    epic: 464,
  };

  it('round-trips a fixture', () => {
    const raw = serialize(StorySchema, story);
    expect(deserialize(StorySchema, raw)).toEqual(story);
  });

  it('rejects kind: task', () => {
    expect(() => StorySchema.parse({ ...story, kind: 'task' })).toThrow();
  });
});

describe('EpicSchema', () => {
  const epic: Epic = {
    schemaVersion: CONTRACTS_SCHEMA_VERSION,
    kind: 'epic' as const,
    title: 'Kernel packages',
    why: 'Proposer and writer apps need a shared typed seam.',
    doneWhen: ['contracts, adr-kit, and repo-context all exist'],
    children: ['#466', '#467', '#468'],
    labels: ['epic'],
  };

  it('round-trips a fixture', () => {
    const raw = serialize(EpicSchema, epic);
    expect(deserialize(EpicSchema, raw)).toEqual(epic);
  });
});
