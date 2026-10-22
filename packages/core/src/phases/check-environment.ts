import type { WorktreeProbe } from '../checkers/index.js';
import type { CheckSummary } from '../types/index.js';

/** Human-readable e2e signal ("playwright.config.ts", "package.json script 'e2e'"), or null when the worktree shows no live-app testing. */
export function detectLiveAppSignal(probe: WorktreeProbe): string | null {
  if (probe.playwrightConfigFiles.length > 0) return probe.playwrightConfigFiles[0];

  for (const [name, script] of Object.entries(probe.scripts)) {
    if (script.includes('playwright') || name === 'e2e' || name.includes('e2e')) {
      return `package.json script '${name}'`;
    }
  }

  return null;
}

/** Human-readable headed-mode signals ("playwright.config.ts forces headless: false",
 *  "package.json script 'e2e' passes --headed"), empty when nothing forces a headed browser. */
export function detectHeadedModeSignals(probe: WorktreeProbe): string[] {
  const signals: string[] = [];

  for (const f of probe.playwrightConfigFiles) {
    const content = probe.playwrightConfigContents[f] ?? '';
    if (/headless\s*:\s*false/.test(content)) {
      signals.push(`${f} forces headless: false`);
    }
  }

  for (const [name, script] of Object.entries(probe.scripts)) {
    if (/(^|\s)--headed\b/.test(script)) {
      signals.push(`package.json script '${name}' passes --headed`);
    } else if (/(^|\s)--ui\b/.test(script)) {
      signals.push(`package.json script '${name}' passes --ui`);
    }
    if (/\bcypress\s+open\b/.test(script)) {
      signals.push(`package.json script '${name}' runs 'cypress open' (interactive UI runner)`);
    }
  }

  return signals;
}

/** Full-output log files named by round-1 FAIL results, then the base-run log dir; deduped, first-seen order. */
export function environmentLogPaths(summary: CheckSummary, baseLogDir: string | undefined): string[] {
  const paths: string[] = [];
  for (const r of summary.results.filter((x) => x.result === 'FAIL')) {
    for (const m of r.details.matchAll(/^full output: (.+)$/gm)) paths.push(m[1]);
  }
  if (baseLogDir !== undefined) paths.push(baseLogDir);
  return [...new Set(paths)];
}
