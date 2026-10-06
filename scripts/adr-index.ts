// scripts/adr-index.ts — Regenerate (or check) the ADR index table in docs/adr/README.md.
//
// Usage: npm run adr:index [-- --check]
// Rewrites only the region between the adr-index markers; scripts/verify.sh runs the --check mode.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildIndexRows, diffIndexRows, parseIndexTable, renderIndexTable, replaceIndexBlock } from '@on-par/adr-kit';

const adrDir = fileURLToPath(new URL('../docs/adr/', import.meta.url));
const readmePath = `${adrDir}README.md`;
const check = process.argv.includes('--check');

function main(): void {
  let rows;
  let readme: string;
  let next: string;
  try {
    const files = readdirSync(adrDir)
      .filter((name) => /^\d{4}-.*\.md$/.test(name))
      .sort()
      .map((filename) => ({ filename, source: readFileSync(`${adrDir}${filename}`, 'utf8') }));
    rows = buildIndexRows(files);
    readme = readFileSync(readmePath, 'utf8');
    next = replaceIndexBlock(readme, renderIndexTable(rows));
  } catch (error) {
    console.error(`adr:index: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (next === readme) {
    console.log('docs/adr/README.md is up to date');
    return;
  }
  if (!check) {
    writeFileSync(readmePath, next);
    console.log(`updated docs/adr/README.md (${rows.length} ADRs)`);
    return;
  }
  console.error('docs/adr/README.md ADR index is stale. Run: npm run adr:index');
  const reasons = diffIndexRows(parseIndexTable(readme), rows);
  for (const line of reasons.length > 0 ? reasons : ['table formatting or order differs']) console.error(line);
  process.exitCode = 1;
}

main();
