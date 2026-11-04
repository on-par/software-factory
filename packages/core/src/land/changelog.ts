const UNRELEASED = /^## Unreleased\s*$/i;

interface Subsection {
  key: string;
  /** Absolute index of the first body line (the line after the heading, or the section's first body line). */
  start: number;
  /** Absolute index one past the last line of the subsection. */
  end: number;
  /** Absolute index of the heading line, or the Unreleased heading for the leading '' subsection. */
  headingIndex: number;
}

interface Section {
  heading: number;
  end: number;
  subsections: Subsection[];
}

function findSection(lines: string[]): Section | undefined {
  const heading = lines.findIndex((line) => UNRELEASED.test(line));
  if (heading === -1) return undefined;
  let end = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
  if (end === -1) end = lines.length;
  const subsections: Subsection[] = [{ key: '', start: heading + 1, end, headingIndex: heading }];
  for (let index = heading + 1; index < end; index++) {
    const line = lines[index] ?? '';
    if (!line.startsWith('### ')) continue;
    const previous = subsections[subsections.length - 1];
    if (previous) previous.end = index;
    subsections.push({ key: line.trimEnd(), start: index + 1, end, headingIndex: index });
  }
  return { heading, end, subsections };
}

function outside(lines: string[], section: Section | undefined): string {
  if (!section) return lines.join('\n');
  return [...lines.slice(0, section.heading), ...lines.slice(section.end)].join('\n');
}

function nonBlank(lines: string[], sub: Subsection | undefined): string[] {
  return sub ? lines.slice(sub.start, sub.end).filter((line) => line.trim() !== '') : [];
}

function lastNonBlank(lines: string[], from: number, end: number): number {
  for (let index = end - 1; index >= from; index--) {
    if ((lines[index] ?? '').trim() !== '') return index;
  }
  return from;
}

export function mergeChangelogUnreleased(
  base: string,
  ours: string,
  theirs: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  const baseLines = base.split('\n');
  const oursLines = ours.split('\n');
  const result = theirs.split('\n');
  const baseSection = findSection(baseLines);
  const oursSection = findSection(oursLines);
  if (!baseSection || !oursSection || !findSection(result)) {
    return { ok: false, reason: 'no ## Unreleased section' };
  }
  if (outside(oursLines, oursSection) !== outside(baseLines, baseSection)) {
    return { ok: false, reason: 'PR changed CHANGELOG.md outside ## Unreleased' };
  }

  const removed = { ok: false as const, reason: 'PR removed or edited an existing Unreleased line' };
  const additions: { key: string; lines: string[] }[] = [];
  for (const sub of baseSection.subsections) {
    if (nonBlank(baseLines, sub).length > 0 && !oursSection.subsections.some((s) => s.key === sub.key)) {
      return removed;
    }
  }
  for (const sub of oursSection.subsections) {
    const baseItems = nonBlank(
      baseLines,
      baseSection.subsections.find((s) => s.key === sub.key),
    );
    const added: string[] = [];
    let matched = 0;
    for (const line of nonBlank(oursLines, sub)) {
      if (matched < baseItems.length && line === baseItems[matched]) matched++;
      else added.push(line);
    }
    if (matched < baseItems.length) return removed;
    if (added.length > 0) additions.push({ key: sub.key, lines: added });
  }

  for (const { key, lines } of additions) {
    const section = findSection(result);
    if (!section) return { ok: false, reason: 'no ## Unreleased section' };
    const sub = section.subsections.find((s) => s.key === key);
    const present = new Set(nonBlank(result, sub));
    const fresh = lines.filter((line) => !present.has(line));
    if (fresh.length === 0) continue;
    if (sub) {
      const at = lastNonBlank(result, sub.headingIndex, sub.end);
      result.splice(at + 1, 0, ...(key === '' && at === section.heading ? [''] : []), ...fresh);
    } else {
      const at = lastNonBlank(result, section.heading, section.end);
      result.splice(at + 1, 0, '', key, '', ...fresh);
    }
  }
  return { ok: true, text: result.join('\n') };
}
