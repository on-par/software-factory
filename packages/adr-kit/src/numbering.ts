// src/numbering.ts — ADR number/filename/slug helpers (#467).

export function formatAdrNumber(value: number, width = 4): string {
  return String(value).padStart(width, '0');
}

export function adrNumberFromFilename(filename: string): number | undefined {
  const basename = filename.split(/[/\\]/).pop() ?? '';
  const match = /^(\d+)[-.]/.exec(basename);
  return match ? Number(match[1]) : undefined;
}

export function nextAdrNumber(existing: readonly number[]): number {
  return existing.length ? Math.max(...existing) + 1 : 1;
}

export function nextAdrNumberFromFilenames(filenames: readonly string[]): number {
  const numbers = filenames
    .map((filename) => adrNumberFromFilename(filename))
    .filter((value): value is number => value !== undefined);
  return nextAdrNumber(numbers);
}

export interface AdrNumberDuplicate {
  number: number;
  /** Filenames sharing `number`, sorted ascending. */
  filenames: string[];
}

export function findDuplicateAdrNumbers(filenames: readonly string[]): AdrNumberDuplicate[] {
  const groups = new Map<number, string[]>();
  for (const filename of filenames) {
    const value = adrNumberFromFilename(filename);
    if (value === undefined) continue;
    const group = groups.get(value);
    if (group) group.push(filename);
    else groups.set(value, [filename]);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([value, group]) => ({ number: value, filenames: [...group].sort() }))
    .sort((a, b) => a.number - b.number);
}

export function adrSlug(title: string): string {
  const dashed = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  while (start < dashed.length && dashed[start] === '-') start++;
  let end = dashed.length;
  while (end > start && dashed[end - 1] === '-') end--;
  return dashed.slice(start, end);
}

export function adrFilename(value: number, title: string, width = 4): string {
  return `${formatAdrNumber(value, width)}-${adrSlug(title)}.md`;
}
