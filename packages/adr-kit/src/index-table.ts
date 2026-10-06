// src/index-table.ts — parse/render/upsert helpers for the ADR index table (#467)
// (the `| Number | Title | Status |` table in docs/adr/README.md).
import { AdrKitError } from './adr.js';
import { formatAdrNumber } from './numbering.js';
import { parseAdr } from './parse.js';

export const ADR_INDEX_START = '<!-- adr-index:start -->';
export const ADR_INDEX_END = '<!-- adr-index:end -->';

export interface AdrIndexRow {
  number: number;
  title: string;
  status: string;
  href: string;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '\\' && (trimmed[i + 1] === '|' || trimmed[i + 1] === '\\')) {
      current += trimmed[i + 1];
      i++;
    } else if (trimmed[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += trimmed[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseNumberCell(cell: string): { number: number | undefined; href: string } {
  const linkMatch = /^\[(\d+)]\(([^)]*)\)$/.exec(cell);
  if (linkMatch) return { number: Number(linkMatch[1]), href: linkMatch[2] };
  const bareMatch = /^(\d+)$/.exec(cell);
  if (bareMatch) return { number: Number(bareMatch[1]), href: '' };
  return { number: undefined, href: '' };
}

interface TableBounds {
  headerIdx: number;
  endIdx: number;
}

function findTable(lines: readonly string[]): TableBounds | undefined {
  for (let i = 0; i < lines.length - 1; i++) {
    const headerCells = splitRow(lines[i]).map((cell) => cell.toLowerCase());
    if (
      headerCells.length < 3 ||
      headerCells[0] !== 'number' ||
      headerCells[1] !== 'title' ||
      headerCells[2] !== 'status'
    ) {
      continue;
    }
    const separatorCells = splitRow(lines[i + 1]);
    if (separatorCells.length < 3 || !separatorCells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    let end = i + 2;
    while (end < lines.length && lines[end].trim().startsWith('|')) end++;
    return { headerIdx: i, endIdx: end };
  }
  return undefined;
}

function parseBodyRows(bodyLines: readonly string[]): AdrIndexRow[] {
  const rows: AdrIndexRow[] = [];
  for (const line of bodyLines) {
    const cells = splitRow(line);
    if (cells.length < 3) continue;
    const { number, href } = parseNumberCell(cells[0]);
    if (number === undefined) continue;
    rows.push({ number, title: cells[1], status: cells[2], href });
  }
  return rows;
}

export function parseIndexTable(markdown: string): AdrIndexRow[] {
  const lines = markdown.split(/\r?\n/);
  const bounds = findTable(lines);
  if (!bounds) return [];
  return parseBodyRows(lines.slice(bounds.headerIdx + 2, bounds.endIdx));
}

function numberCellText(row: AdrIndexRow): string {
  return row.href === '' ? String(row.number) : `[${formatAdrNumber(row.number)}](${row.href})`;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(width - text.length);
}

export function renderIndexTable(rows: readonly AdrIndexRow[]): string {
  const headerCells = ['Number', 'Title', 'Status'];
  const escapeCell = (cell: string) => cell.replace(/[\\|]/g, '\\$&');
  const bodyCellsList = rows.map((row) => [numberCellText(row), escapeCell(row.title), escapeCell(row.status)]);
  const widths = headerCells.map((header, col) =>
    Math.max(header.length, ...bodyCellsList.map((cells) => cells[col].length)),
  );
  const renderRow = (cells: readonly string[]) => `| ${cells.map((cell, col) => pad(cell, widths[col])).join(' | ')} |`;
  const separator = `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`;
  return [renderRow(headerCells), separator, ...bodyCellsList.map(renderRow)].join('\n');
}

export function upsertIndexRow(markdown: string, row: AdrIndexRow): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const bounds = findTable(lines);
  if (!bounds) throw new AdrKitError('no ADR index table found', 'index');

  const existingRows = parseBodyRows(lines.slice(bounds.headerIdx + 2, bounds.endIdx));
  const mergedRows = [...existingRows.filter((existing) => existing.number !== row.number), row].sort(
    (a, b) => a.number - b.number,
  );
  const renderedTable = renderIndexTable(mergedRows).split('\n');

  const newLines = [...lines.slice(0, bounds.headerIdx), ...renderedTable, ...lines.slice(bounds.endIdx)];
  let result = newLines.join('\n');
  if (eol === '\r\n') result = result.replace(/\n/g, '\r\n');
  return result;
}

export interface AdrIndexSource {
  /** Bare file name, e.g. '0001-boss-worker-checker-pipeline.md'. Also used as the row href. */
  filename: string;
  source: string;
}

function rowFromSource({ filename, source }: AdrIndexSource): AdrIndexRow {
  let adr;
  try {
    adr = parseAdr(source, { filename });
  } catch (error) {
    throw new AdrKitError(`${filename}: ${error instanceof Error ? error.message : String(error)}`, 'parse');
  }
  if (adr.number === undefined) throw new AdrKitError(`${filename}: ADR has no number`, 'parse');
  const title = adr.title.trim();
  if (title === '') throw new AdrKitError(`${filename}: ADR has an empty title`, 'parse');
  const status = adr.status.trim();
  if (status === '') throw new AdrKitError(`${filename}: ADR has no Status line`, 'parse');
  return { number: adr.number, title, status, href: filename };
}

export function buildIndexRows(files: readonly AdrIndexSource[]): AdrIndexRow[] {
  return files.map(rowFromSource).sort((a, b) => {
    if (a.number !== b.number) return a.number - b.number;
    if (a.href === b.href) return 0;
    return a.href < b.href ? -1 : 1;
  });
}

export function replaceIndexBlock(markdown: string, table: string): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const startIdx = markdown.indexOf(ADR_INDEX_START);
  const endIdx = markdown.indexOf(ADR_INDEX_END);
  if (startIdx === -1) throw new AdrKitError(`missing ${ADR_INDEX_START} marker`, 'index');
  if (endIdx === -1) throw new AdrKitError(`missing ${ADR_INDEX_END} marker`, 'index');
  if (markdown.indexOf(ADR_INDEX_START, startIdx + 1) !== -1) {
    throw new AdrKitError(`duplicate ${ADR_INDEX_START} marker`, 'index');
  }
  if (markdown.indexOf(ADR_INDEX_END, endIdx + 1) !== -1) {
    throw new AdrKitError(`duplicate ${ADR_INDEX_END} marker`, 'index');
  }
  if (endIdx < startIdx) throw new AdrKitError(`${ADR_INDEX_END} comes before ${ADR_INDEX_START}`, 'index');
  const body = table.replace(/\r?\n/g, eol);
  return markdown.slice(0, startIdx + ADR_INDEX_START.length) + eol + eol + body + eol + eol + markdown.slice(endIdx);
}

export function diffIndexRows(committed: readonly AdrIndexRow[], generated: readonly AdrIndexRow[]): string[] {
  const committedByHref = new Map(committed.map((row) => [row.href, row]));
  const generatedHrefs = new Set(generated.map((row) => row.href));
  const lines: string[] = [];
  for (const row of generated) {
    const label = formatAdrNumber(row.number);
    const old = committedByHref.get(row.href);
    if (!old) {
      lines.push(`missing row: ${label} (${row.href})`);
      continue;
    }
    if (old.title !== row.title) {
      lines.push(`stale title: ${label} — index has "${old.title}", ADR has "${row.title}"`);
    }
    if (old.status !== row.status) {
      lines.push(`stale status: ${label} — index has "${old.status}", ADR has "${row.status}"`);
    }
  }
  for (const row of committed) {
    if (!generatedHrefs.has(row.href)) lines.push(`extra row: ${formatAdrNumber(row.number)} (${row.href})`);
  }
  return lines;
}
