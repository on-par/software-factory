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
