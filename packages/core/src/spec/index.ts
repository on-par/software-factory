// src/spec/index.ts — the frozen-spec artifact set (#666): owns every path in the
// four-file family (.factory/plans/issue-N.md plus the design JSON/MD and ADR-drafts
// sidecars), the single route-normalization site, the only writer of the set, and the
// archive rule. All six former consumers (plan, eval/score, eval/golden, sim/regressions,
// design, adr/write) route through this module.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import matter from 'gray-matter';

export interface SpecPaths {
  /** The spec file itself (specPath unchanged). */
  md: string;
  /** <base>.design.json */
  designJson: string;
  /** <base>.design.md */
  designMd: string;
  /** <base>.adr.json */
  adr: string;
}

export function specPaths(specPath: string): SpecPaths {
  const base = specPath.replace(/\.md$/, '');
  return {
    md: specPath,
    designJson: `${base}.design.json`,
    designMd: `${base}.design.md`,
    adr: `${base}.adr.json`,
  };
}

export interface FrozenSpec {
  path: string;
  /** Raw file content as read from disk (or passed to parseSpec). */
  raw: string;
  /** Markdown body with the frontmatter stripped. */
  body: string;
  /** Parsed frontmatter; {} when absent or unparsable. */
  data: Record<string, unknown>;
  /** Normalized route: .trim() + validate. null when missing/unparseable/non-string. */
  route: 'codex' | 'claude' | null;
}

/** The single route-normalization site. Never throws. */
export function parseSpec(content: string): FrozenSpec {
  let data: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = matter(content);
    data = parsed.data;
    body = parsed.content;
  } catch {
    // malformed YAML frontmatter -> fall back to {} and the raw content
  }

  const t = typeof data.route === 'string' ? data.route.trim() : '';
  const route: 'codex' | 'claude' | null = t === 'codex' || t === 'claude' ? t : null;
  return { path: '', raw: content, body, data, route };
}

/** Reads a spec file off disk and parses it. Throws only on ENOENT. */
export async function readSpec(specPath: string): Promise<FrozenSpec> {
  const raw = await readFile(specPath, 'utf-8');
  return { ...parseSpec(raw), path: specPath };
}

/** Serializes body + frontmatter; returns the body unchanged when data is empty. */
export function stringifySpec(body: string, data: Record<string, unknown>): string {
  return Object.keys(data).length > 0 ? matter.stringify(body, data) : body;
}

export interface WriteSpecInput {
  /** When present, the .md is (re)written with this body (plus data when non-empty). */
  body?: string;
  /** Frontmatter for the .md write. Ignored when body is absent. */
  data?: Record<string, unknown>;
  /** Pre-rendered <base>.design.json content. */
  designJson?: string;
  /** Pre-rendered <base>.design.md content. */
  designMd?: string;
  /** Pre-rendered <base>.adr.json content. */
  adrDrafts?: string;
}

/** The only writer of the artifact set. Sidecar fields are pre-rendered strings. */
export async function writeSpec(specPath: string, spec: WriteSpecInput): Promise<void> {
  if (spec.body !== undefined) {
    const content =
      spec.data !== undefined && Object.keys(spec.data).length > 0 ? stringifySpec(spec.body, spec.data) : spec.body;
    await writeFile(specPath, content);
  }

  const paths = specPaths(specPath);
  const sidecars: Array<{ path: string; content?: string }> = [
    { path: paths.designJson, content: spec.designJson },
    { path: paths.designMd, content: spec.designMd },
    { path: paths.adr, content: spec.adrDrafts },
  ];
  for (const { path, content } of sidecars) {
    if (content === undefined) continue;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** Archives every present member of the four-file set under .archive with one timestamp. */
export async function archiveSpec(specPath: string): Promise<string[]> {
  const files = Object.values(specPaths(specPath)).filter((file) => existsSync(file));
  if (files.length === 0) return [];

  const archiveDir = join(dirname(specPath), '.archive');
  const timestamp = Date.now();
  await mkdir(archiveDir, { recursive: true });

  const archived: string[] = [];
  for (const file of files) {
    const archivedPath = join(archiveDir, `${timestamp}-${basename(file)}`);
    await rename(file, archivedPath);
    archived.push(archivedPath);
  }
  return archived;
}

/**
 * Post-freeze route rewrite. `reason` is accepted for #664's consumption; the caller
 * logs its own message as today. Also repairs a spec whose frontmatter was malformed.
 */
export async function updateSpecRoute(specPath: string, route: 'codex' | 'claude', reason: string): Promise<void> {
  void reason;
  const parsed = await readSpec(specPath);
  await writeSpec(specPath, { body: parsed.body, data: { ...parsed.data, route } });
}
