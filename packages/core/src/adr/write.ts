// src/adr/write.ts — the ADR writer: turns PLAN-emitted ADR drafts into Accepted ADRs in
// the target repo's docs/adr, the factory's sole write path for that directory (#482).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  adrFilename,
  adrNumberFromFilename,
  adrSlug,
  createAdr,
  detectConvention,
  nextAdrNumberFromFilenames,
  normalizeStatus,
  NYGARD_CONVENTION,
  parseAdr,
  serializeAdr,
  upsertIndexRow,
} from '@on-par/adr-kit';
import type { AdrDraft } from '@on-par/contracts';
import { AdrDraftSchema } from '@on-par/contracts';
import type { RepoContextReader } from '@on-par/repo-context';

import { DEFAULT_ADR_DIR } from './index.js';

/** The index table lives in the ADR home's README.md — see docs/adr/README.md. */
export const ADR_INDEX_FILE = 'README.md';
/** Cap on ADRs one lane may mint — a runaway plan must not spam docs/adr. */
export const MAX_ADR_DRAFTS = 5;
/** Existing ADRs sampled to detect the repo's convention. */
const CONVENTION_SAMPLE = 10;

const NON_ADR_FILENAME = /^(readme|index|_?template)\.md$/i;

export interface RejectedAdrDraft {
  title: string;
  errors: string[];
}
export interface SkippedAdrDraft {
  title: string;
  path: string;
  reason: 'already-accepted' | 'cap';
}
export interface AdrFileWrite {
  /** Repo-root-relative, e.g. 'docs/adr/0005-cache-repo-context.md'. */
  path: string;
  contents: string;
  number: number;
  title: string;
  /** True when this overwrote an existing Proposed ADR rather than minting a new number. */
  promoted: boolean;
}
export interface AdrWritePlan {
  dir: string;
  writes: AdrFileWrite[];
  /** The rewritten index file; absent when there is no table to update. */
  index?: { path: string; contents: string };
  indexSkipped?: 'missing' | 'no-table';
  rejected: RejectedAdrDraft[];
  skipped: SkippedAdrDraft[];
}

/** The quality gate — [] for a good draft, else every unmet requirement, in order. */
export function adrDraftErrors(draft: AdrDraft): string[] {
  const errors: string[] = [];
  if (draft.title.trim() === '') errors.push('title is required');
  if (draft.context.trim() === '') {
    errors.push("rationale ('why') is required — Context must explain why this decision was made");
  }
  if (draft.decision.trim() === '') errors.push('Decision is required');
  if (draft.consequences.trim() === '') errors.push('Consequences are required');
  return errors;
}

function draftTitleOrUntitled(entry: unknown): string {
  if (
    typeof entry === 'object' &&
    entry !== null &&
    'title' in entry &&
    typeof (entry as { title: unknown }).title === 'string' &&
    (entry as { title: string }).title.trim() !== ''
  ) {
    return (entry as { title: string }).title;
  }
  return '(untitled)';
}

/** Spec frontmatter -> validated drafts + rejections. `[]`/`[]` when there is no `adr` block. */
export function parseAdrDrafts(frontmatter: unknown): { drafts: AdrDraft[]; rejected: RejectedAdrDraft[] } {
  if (typeof frontmatter !== 'object' || frontmatter === null || !('adr' in frontmatter)) {
    return { drafts: [], rejected: [] };
  }

  const raw = (frontmatter as { adr: unknown }).adr;
  if (raw === null || raw === undefined) {
    return { drafts: [], rejected: [] };
  }
  if (!Array.isArray(raw)) {
    return { drafts: [], rejected: [{ title: '(untitled)', errors: ['adr: must be a list of ADR drafts'] }] };
  }

  const drafts: AdrDraft[] = [];
  const rejected: RejectedAdrDraft[] = [];
  for (const entry of raw) {
    const result = AdrDraftSchema.safeParse(entry);
    if (!result.success) {
      rejected.push({
        title: draftTitleOrUntitled(entry),
        errors: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
      continue;
    }
    const errors = adrDraftErrors(result.data);
    if (errors.length > 0) {
      rejected.push({ title: result.data.title, errors });
    } else {
      drafts.push(result.data);
    }
  }
  return { drafts, rejected };
}

/** Mirrors `designArtifactPaths` in `packages/core/src/design/index.ts`. */
export function adrDraftsPath(specPath: string): string {
  return `${specPath.replace(/\.md$/, '')}.adr.json`;
}

/** Reads the frozen drafts off disk. Never throws — `[]` for any failure. */
export async function readAdrDrafts(specPath: string): Promise<AdrDraft[]> {
  let raw: string;
  try {
    raw = await readFile(adrDraftsPath(specPath), 'utf-8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const result = AdrDraftSchema.array().safeParse(parsed);
  return result.success ? result.data : [];
}

export async function planAdrWrites(
  reader: RepoContextReader,
  drafts: readonly AdrDraft[],
  opts: { date: string; dir?: string; maxDrafts?: number; issueRef?: { text: string; url: string } },
): Promise<AdrWritePlan> {
  const dir = opts.dir ?? DEFAULT_ADR_DIR;
  const maxDrafts = opts.maxDrafts ?? MAX_ADR_DRAFTS;

  const entries = await reader.readDir(dir);
  const adrFiles = entries.filter(
    (entry) => entry.type === 'file' && /\.md$/i.test(entry.name) && !NON_ADR_FILENAME.test(entry.name),
  );

  const conventionTexts: string[] = [];
  for (const entry of adrFiles.slice(0, CONVENTION_SAMPLE)) {
    const file = await reader.readFile(entry.path);
    if (file !== undefined) conventionTexts.push(file.text);
  }
  const convention = conventionTexts.length > 0 ? detectConvention(conventionTexts) : NYGARD_CONVENTION;

  let nextNumber = nextAdrNumberFromFilenames(adrFiles.map((entry) => entry.name));

  let indexMarkdown = (await reader.readFile(`${dir}/${ADR_INDEX_FILE}`))?.text;
  let indexSkipped: 'missing' | 'no-table' | undefined = indexMarkdown === undefined ? 'missing' : undefined;

  const rejected: RejectedAdrDraft[] = [];
  const validated: AdrDraft[] = [];
  for (const draft of drafts) {
    const errors = adrDraftErrors(draft);
    if (errors.length > 0) rejected.push({ title: draft.title, errors });
    else validated.push(draft);
  }
  const survivors = validated.slice(0, maxDrafts);
  const skipped: SkippedAdrDraft[] = validated
    .slice(maxDrafts)
    .map((draft) => ({ title: draft.title, path: '', reason: 'cap' as const }));

  const writes: AdrFileWrite[] = [];

  for (const draft of survivors) {
    const slug = adrSlug(draft.title);
    const slugPattern = new RegExp(`^\\d+-${slug}\\.md$`);
    const existing = adrFiles.find((entry) => slugPattern.test(entry.name));

    let number: number;
    let path: string;
    let promoted: boolean;

    if (existing) {
      const file = await reader.readFile(existing.path);
      const parsed = file !== undefined ? parseAdr(file.text, { filename: existing.name }) : undefined;
      if (parsed !== undefined && normalizeStatus(parsed.status) === 'Proposed') {
        number = parsed.number ?? adrNumberFromFilename(existing.name) ?? nextNumber++;
        path = existing.path;
        promoted = true;
      } else {
        skipped.push({ title: draft.title, path: existing.path, reason: 'already-accepted' });
        continue;
      }
    } else {
      number = nextNumber++;
      path = `${dir}/${adrFilename(number, draft.title, convention.numberWidth)}`;
      promoted = false;
    }

    const references = draft.references.map((ref) => ({ text: ref.text, url: ref.url, marker: '-' }));
    if (opts.issueRef && !references.some((ref) => ref.url === opts.issueRef?.url)) {
      references.push({ text: opts.issueRef.text, url: opts.issueRef.url, marker: '-' });
    }

    const contents = serializeAdr(
      createAdr({
        number,
        title: draft.title,
        status: 'Accepted',
        date: opts.date,
        context: draft.context.trim(),
        decision: draft.decision.trim(),
        consequences: draft.consequences.trim(),
        references,
      }),
      convention,
    );

    writes.push({ path, contents, number, title: draft.title, promoted });

    if (indexMarkdown !== undefined) {
      try {
        indexMarkdown = upsertIndexRow(indexMarkdown, {
          number,
          title: draft.title,
          status: 'Accepted',
          href: path.split('/').pop() ?? path,
        });
      } catch {
        indexSkipped = 'no-table';
        indexMarkdown = undefined;
      }
    }
  }

  return {
    dir,
    writes,
    index:
      indexMarkdown !== undefined && writes.length > 0
        ? { path: `${dir}/${ADR_INDEX_FILE}`, contents: indexMarkdown }
        : undefined,
    indexSkipped,
    rejected,
    skipped,
  };
}

/** The only write. Returns the repo-relative paths written, in write-then-index order. */
export async function applyAdrWritePlan(plan: AdrWritePlan, opts: { root: string }): Promise<string[]> {
  const items: { path: string; contents: string }[] = [...plan.writes];
  if (plan.index) items.push(plan.index);

  const written: string[] = [];
  for (const item of items) {
    const abs = join(opts.root, item.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, item.contents, 'utf-8');
    written.push(item.path);
  }
  return written;
}
