/** Return whether a frozen spec has substantive content in a Files / approach section. */
export function specHasImplementation(body: string): boolean {
  const lines = stripHtmlComments(body).split(/\r?\n/);
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let inSection = false;
  let sectionHasContent = false;

  for (const line of lines) {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenceMatch?.[1]?.[0] === fence.marker && (fenceMatch[1].length ?? 0) >= fence.length) {
        fence = null;
      } else if (inSection && isSubstantive(line)) {
        sectionHasContent = true;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0] as '`' | '~', length: fenceMatch[1]!.length };
      continue;
    }

    const heading = /^( {0,3})(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (heading && heading[2]!.length <= 2) {
      if (inSection && sectionHasContent) return true;
      inSection = heading[2]!.length === 2 && isFilesApproachHeading(heading[3]!);
      sectionHasContent = false;
      continue;
    }
    if (inSection && isSubstantive(line)) sectionHasContent = true;
  }

  return inSection && sectionHasContent;
}

/** Remove every `<!-- ... -->` comment, including multi-line ones. An unclosed `<!--` hides the
 *  rest of the text, as it does when Markdown renders it. Uses indexOf, not a regex, so a nested
 *  or overlapping `<!--` can't survive a single replacement pass. */
function stripHtmlComments(text: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const open = text.indexOf('<!--', pos);
    if (open === -1) return out + text.slice(pos);
    out += text.slice(pos, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return out;
    pos = close + 3;
  }
}

function isFilesApproachHeading(text: string): boolean {
  return (
    text
      .replace(/\s*\/\s*/g, ' / ')
      .trim()
      .toLowerCase() === 'files / approach'
  );
}

function isSubstantive(line: string): boolean {
  let text = line.trim();
  if (text.length === 0 || /^#{1,6}(?:\s|$)/.test(text) || /^(`{3,}|~{3,})/.test(text)) return false;
  if (text.length === 0) return false;
  text = text.replace(/^(?:[-+*]|\d+[.)])[ \t]*/, '').trim();
  text = text.replace(/^[*_`]+|[*_`]+$/g, '').trim();
  text = text.replace(/[.!?]+$/g, '').trim();
  text = text.replace(/^[*_`]+|[*_`]+$/g, '').trim();
  if (text.length === 0) return false;
  if (/^(?:tbd|todo|n\/a|none|\.\.\.|…)$/.test(text.toLowerCase())) return false;
  if (/^<[^<>]+>$/.test(text)) return false;
  return true;
}

export function invalidPlanReason(errors: readonly string[], attempts: number): string {
  const reason = `invalid plan: no valid design artifact after ${attempts} attempt(s) and the spec has no Files / approach section`;
  const diagnostics = errors.slice(0, 3).join('; ');
  return diagnostics.length > 0 ? `${reason}: ${diagnostics}` : reason;
}
