// src/index-table.ts — parse/render/upsert helpers for the ADR index table (#467)
// (the `| Number | Title | Status |` table in docs/adr/README.md).
import { AdrKitError } from './adr.js';
import { formatAdrNumber } from './numbering.js';

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
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      current += '|';
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
  const bodyCellsList = rows.map((row) => [numberCellText(row), row.title, row.status]);
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
