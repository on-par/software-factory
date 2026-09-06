/** Recognize a named scenario with optional Markdown list/checkbox/emphasis. */
export function isScenarioCriterion(text: string): boolean {
  return /^(?:\*\*|__)?Scenario:\s*\S/i.test(stripMarker(text));
}

function stripMarker(line: string): string {
  return line.trim().replace(/^[-*+]\s+(?:\[[ xX]\]\s*)?/, '');
}

/** Preserve legacy lines, but keep each named scenario and its steps together. */
export function parseAcceptanceCriteriaSection(section: string): string[] {
  const criteria: string[] = [];
  for (const raw of section.split('\n')) {
    if (/^\s*(?:`{3,}|~{3,})/.test(raw)) continue;
    const line = stripMarker(raw);
    if (!line) continue;
    const last = criteria.length - 1;
    if (last >= 0 && isScenarioCriterion(criteria[last]) && /^(?:Given|When|Then|And|But)\s+\S|^\|/i.test(line)) {
      criteria[last] += `\n${line}`;
    } else {
      criteria.push(line);
    }
  }
  return criteria.some(isScenarioCriterion)
    ? criteria.filter((criterion) => !/^Feature:\s*\S/i.test(criterion))
    : criteria;
}

/** Complete scenarios are an alternative to the established checkbox format. */
export function hasCompleteScenarios(section: string): boolean {
  const scenarios = parseAcceptanceCriteriaSection(section).filter(isScenarioCriterion);
  return (
    scenarios.length > 0 &&
    scenarios.every(
      (scenario) => /^Given\s+\S/im.test(scenario) && /^When\s+\S/im.test(scenario) && /^Then\s+\S/im.test(scenario),
    )
  );
}
