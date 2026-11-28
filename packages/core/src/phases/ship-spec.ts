import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { readDesignArtifact } from '../design/index.js';
import { readSpec, specPaths } from '../spec/index.js';

export async function readSpecBody(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readSpec(specPath)).body;
  } catch {
    return undefined;
  }
}

export async function readRisk(specPath: string | undefined): Promise<string | undefined> {
  if (!specPath) return undefined;
  try {
    return (await readDesignArtifact(specPath))?.riskBlastRadius;
  } catch {
    return undefined;
  }
}

const NoteItem = z.object({ aspect: z.string(), text: z.string() });
const ReadinessNotesSchema = z.object({
  verdict: z.enum(['ready', 'ready-with-assumptions', 'not-ready']),
  assumptions: z.array(NoteItem),
  questions: z.array(NoteItem).optional(),
});

interface ReadinessNotes {
  assumptions: string[];
  questions: string[];
}

export async function readReadinessNotes(specPath: string | undefined): Promise<ReadinessNotes> {
  const none: ReadinessNotes = { assumptions: [], questions: [] };
  if (!specPath) return none;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(specPaths(specPath).readiness, 'utf-8'));
  } catch {
    return none;
  }
  const parsed = ReadinessNotesSchema.safeParse(raw);
  if (!parsed.success) return none;
  const line = (item: z.infer<typeof NoteItem>): string => `[${item.aspect}] ${item.text}`;
  return { assumptions: parsed.data.assumptions.map(line), questions: (parsed.data.questions ?? []).map(line) };
}
