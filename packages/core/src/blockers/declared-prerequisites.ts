/**
 * Find explicit same-repository prerequisite declarations in an issue body: `Prerequisite:` and
 * `Depends on:` lines, each with one `#N` or a comma list such as `#3, #4`.
 */
export function findDeclaredPrerequisites(body: string): number[] {
  const found = new Set<number>();
  let fence: { marker: '`' | '~'; length: number } | undefined;

  for (const line of body.split(/\r?\n/)) {
    if (fence) {
      const close = new RegExp(`^\\s*${fence.marker}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
      continue;
    }
    const opening = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1][0] as '`' | '~', length: opening[1].length };
      continue;
    }
    const declaration =
      /^\s*(?:[-*+]\s+)?(?:Prerequisite|Depends\s+on):\s*(#[1-9]\d*(?!\d)(?:\s*,\s*#[1-9]\d*(?!\d))*)/i.exec(line);
    if (!declaration) continue;
    for (const reference of declaration[1].matchAll(/#(\d+)/g)) {
      const issue = Number(reference[1]);
      if (Number.isSafeInteger(issue)) found.add(issue);
    }
  }
  return [...found];
}
