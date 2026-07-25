// src/adr.ts — the typed Adr record, its error type, and the createAdr constructor (#467).

export type AdrStatusValue = 'Proposed' | 'Accepted' | 'Rejected' | 'Deprecated' | 'Superseded';

const STATUS_VALUES: readonly AdrStatusValue[] = ['Proposed', 'Accepted', 'Rejected', 'Deprecated', 'Superseded'];

export interface AdrReference {
  /** Link text, or the whole bullet when it is not a link. */
  text: string;
  url?: string;
  /** The bullet marker used in the source ('-' or '*'), for byte-stable serialization. */
  marker: string;
}

/** A section the kit does not map to a known field; replayed verbatim on serialize. */
export interface AdrSection {
  heading: string;
  body: string;
}

export interface Adr {
  /** undefined when neither the H1 nor the filename carries a number. */
  number: number | undefined;
  title: string;
  /** Raw status text as written, e.g. 'Accepted' or 'Superseded by ADR-0007'. */
  status: string;
  /** Raw date text as written, normally ISO 'YYYY-MM-DD'. '' when absent. */
  date: string;
  context: string;
  decision: string;
  consequences: string;
  references: AdrReference[];
  /** Section labels in document order (known + extra). Empty for a constructed ADR. */
  sectionOrder: string[];
  /** Sections not mapped to a known field, keyed by their heading. */
  extraSections: AdrSection[];
}

export class AdrKitError extends Error {
  constructor(
    message: string,
    readonly code: 'parse' | 'index',
  ) {
    super(message);
    this.name = 'AdrKitError';
  }
}

/** Match the first word of `raw` case-insensitively against the five known statuses. */
export function normalizeStatus(raw: string): AdrStatusValue | undefined {
  const firstWord = raw.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return STATUS_VALUES.find((value) => value.toLowerCase() === firstWord);
}

/** Extract the ADR number a 'Superseded by ...' status points to, else undefined. */
export function supersededBy(raw: string): number | undefined {
  if (normalizeStatus(raw) !== 'Superseded') return undefined;
  const match = /(\d+)/.exec(raw);
  return match ? Number(match[1]) : undefined;
}

export interface CreateAdrInput {
  number?: number;
  title: string;
  status?: string;
  date?: string;
  context?: string;
  decision?: string;
  consequences?: string;
  references?: AdrReference[];
}

/** Build a new ADR from scratch. Pure — callers pass `date`, so no clock read. */
export function createAdr(input: CreateAdrInput): Adr {
  return {
    number: input.number,
    title: input.title,
    status: input.status ?? 'Proposed',
    date: input.date ?? '',
    context: input.context ?? '',
    decision: input.decision ?? '',
    consequences: input.consequences ?? '',
    references: input.references ?? [],
    sectionOrder: [],
    extraSections: [],
  };
}
