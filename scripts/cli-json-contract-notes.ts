import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  diffCliJsonSchemas,
  inventory,
  readSchema,
  type CliJsonSchemaDiff,
  type ContractCheckIo,
  type ContractFinding,
} from './check-cli-json-contract.js';

const USAGE = 'usage: cli-json-contract-notes.ts --from <tag> [--to <ref>]';

function findingLine(finding: ContractFinding): string {
  return `  - \`${finding.path}\`: ${finding.oldType} -> ${finding.newType} (${finding.reason})`;
}

function addedLines(added: string[]): string[] {
  return added.map((path) => `  - added \`${path}\``);
}

function breakingEntry(diff: CliJsonSchemaDiff): string[] {
  let headline = `schemaVersion ${diff.oldVersion} -> ${diff.newVersion}`;
  if (diff.newVersion < diff.oldVersion) headline += ' (decreased)';
  else if (diff.newVersion === diff.oldVersion) headline = `schemaVersion ${diff.newVersion} (not bumped)`;
  return [`- \`${diff.command}\`: ${headline}`, ...diff.breaking.map(findingLine), ...addedLines(diff.added)];
}

export function renderCliJsonContractNotes(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const breaking: string[][] = [];
  const additive: string[] = [];
  const created: string[] = [];
  for (const command of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    if (!(command in before)) {
      const version = diffCliJsonSchemas(command, after[command], after[command]).newVersion;
      created.push(`- \`${command}\` (schemaVersion ${version})`);
      continue;
    }
    if (!(command in after)) {
      const version = diffCliJsonSchemas(command, before[command], before[command]).newVersion;
      breaking.push([`- \`${command}\`: schema removed (was schemaVersion ${version})`]);
      continue;
    }
    const diff = diffCliJsonSchemas(command, before[command], after[command]);
    if (diff.newVersion !== diff.oldVersion || diff.breaking.length > 0) breaking.push(breakingEntry(diff));
    else if (diff.added.length > 0)
      additive.push(`- \`${command}\`: added ${diff.added.map((p) => `\`${p}\``).join(', ')}`);
  }

  const sections: string[] = [];
  if (breaking.length)
    sections.push(['### Breaking changes (schemaVersion bumped)', '', ...breaking.flat()].join('\n'));
  if (additive.length) sections.push(['### Added fields', '', ...additive].join('\n'));
  if (created.length) sections.push(['### New commands', '', ...created].join('\n'));
  if (!sections.length) sections.push('No CLI JSON contract changes');
  return `## CLI JSON contract\n\n${sections.join('\n\n')}\n`;
}

function parseArgs(argv: readonly string[]): { from: string; to: string } {
  let from: string | undefined;
  let to = 'HEAD';
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value || value.startsWith('-')) throw new Error(USAGE);
    if (flag === '--from') from = value;
    else if (flag === '--to') to = value;
    else throw new Error(USAGE);
  }
  if (!from) throw new Error(USAGE);
  return { from, to };
}

function readRef(ref: string, git: (args: readonly string[]) => string): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (const path of inventory(ref, git)) {
    const command =
      path
        .split('/')
        .at(-1)
        ?.replace(/\.schema\.json$/, '') ?? path;
    schemas[command] = readSchema(ref, path, git);
  }
  return schemas;
}

export function runCliJsonContractNotes(argv: readonly string[], io: ContractCheckIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  const error = io.error ?? ((line: string) => console.error(line));
  try {
    const { from, to } = parseArgs(argv);
    const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const cwd = io.cwd ?? scriptRoot;
    const git = io.git ?? ((args: readonly string[]) => execFileSync('git', [...args], { cwd, encoding: 'utf8' }));
    const before = readRef(from, git);
    const after = readRef(to, git);
    if (Object.keys(after).length === 0) {
      throw new Error(`${to} has no CLI schema artifacts under packages/cli/schemas`);
    }
    log(renderCliJsonContractNotes(before, after).trimEnd());
    return 0;
  } catch (cause) {
    error(`cli-json-contract-notes: ${cause instanceof Error ? cause.message : String(cause)}`);
    error(USAGE);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runCliJsonContractNotes(process.argv.slice(2));
}
