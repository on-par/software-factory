import { describe, expect, it } from 'vitest';

import { AdrDraftSchema } from './adr.js';
import { deserialize, serialize } from './serde.js';

const validDraft = {
  title: 'Record architecture decisions in docs/adr',
  context: 'Decisions made during PLAN evaporate into spec prose and are never recorded.',
  decision: 'SHIP materializes PLAN-emitted ADR drafts as Accepted ADRs via @on-par/adr-kit.',
  consequences: 'Future PLAN runs can read prior decisions back; a bad draft is refused, not written.',
  status: 'proposed' as const,
  references: [{ text: 'Issue #482', url: 'https://github.com/on-par/software-factory/issues/482' }],
};

describe('AdrDraftSchema', () => {
  it('round-trips a fully populated draft', () => {
    const raw = serialize(AdrDraftSchema, validDraft);
    expect(deserialize(AdrDraftSchema, raw)).toEqual(validDraft);
  });

  it('defaults status to "proposed" when omitted', () => {
    const { status, ...withoutStatus } = validDraft;
    void status;
    const parsed = AdrDraftSchema.parse(withoutStatus);
    expect(parsed.status).toBe('proposed');
  });

  it('accepts status "accepted"', () => {
    const parsed = AdrDraftSchema.parse({ ...validDraft, status: 'accepted' });
    expect(parsed.status).toBe('accepted');
  });

  it('defaults references to [] when omitted', () => {
    const { references, ...withoutReferences } = validDraft;
    void references;
    const parsed = AdrDraftSchema.parse(withoutReferences);
    expect(parsed.references).toEqual([]);
  });

  it('defaults references to [] for an explicit null (bare YAML key)', () => {
    const parsed = AdrDraftSchema.parse({ ...validDraft, references: null });
    expect(parsed.references).toEqual([]);
  });

  it('keeps a populated references array', () => {
    const parsed = AdrDraftSchema.parse(validDraft);
    expect(parsed.references).toEqual(validDraft.references);
  });

  it('defaults context/decision/consequences to "" when omitted', () => {
    const { context, decision, consequences, ...rest } = validDraft;
    void context;
    void decision;
    void consequences;
    const parsed = AdrDraftSchema.parse(rest);
    expect(parsed.context).toBe('');
    expect(parsed.decision).toBe('');
    expect(parsed.consequences).toBe('');
  });

  it('rejects an empty title', () => {
    expect(() => AdrDraftSchema.parse({ ...validDraft, title: '' })).toThrow();
  });

  it('rejects a missing title', () => {
    const { title, ...withoutTitle } = validDraft;
    void title;
    expect(() => AdrDraftSchema.parse(withoutTitle)).toThrow();
  });

  it('parses a reference with text only (no url)', () => {
    const parsed = AdrDraftSchema.parse({ ...validDraft, references: [{ text: 'internal note' }] });
    expect(parsed.references).toEqual([{ text: 'internal note' }]);
  });

  it('rejects a reference with an empty text', () => {
    expect(() => AdrDraftSchema.parse({ ...validDraft, references: [{ text: '' }] })).toThrow();
  });

  it('rejects an unknown status value', () => {
    expect(() => AdrDraftSchema.parse({ ...validDraft, status: 'accepted-ish' })).toThrow();
  });
});
