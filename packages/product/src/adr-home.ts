// packages/product/src/adr-home.ts — where the product app records ADRs (#469).
//
// The monorepo has ONE ADR home: docs/adr/ at the repo root. adr-kit's numbering is
// per-directory (nextAdrNumber maxes over the numbers already present), so a second home
// under packages/product would mint a second "ADR-0005" and make every cross-reference
// ambiguous. docs/adr/README.md already declares the Michael Nygard template, which is
// exactly adr-kit's NYGARD_CONVENTION.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { adrFilename, nextAdrNumberFromFilenames, NYGARD_CONVENTION } from '@on-par/adr-kit';

/** Repo-root-relative path to the monorepo's single ADR home. */
export const ADR_HOME_DIR = 'docs/adr';

/** The ADR style this repo writes — see docs/adr/README.md. */
export const ADR_CONVENTION = NYGARD_CONVENTION;

export function resolveAdrHome(repoRoot: string): string {
  return resolve(repoRoot, ADR_HOME_DIR);
}

/** Filename for the next ADR in a home, given the filenames already in it. */
export function nextAdrFilename(existing: readonly string[], title: string): string {
  return adrFilename(nextAdrNumberFromFilenames(existing), title, ADR_CONVENTION.numberWidth);
}

/** ADR files in a home — README.md is the index, not a decision record. */
export function listAdrFilenames(dir: string, readDir: (path: string) => string[] = readdirSync): string[] {
  return readDir(dir).filter((name) => name.endsWith('.md') && name !== 'README.md');
}
