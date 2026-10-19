import { describe, expect, it } from 'vitest';

import type { WorktreeProbe } from '../checkers/index.js';
import { detectHeadedModeSignals, detectLiveAppSignal } from './check-environment.js';

const probe = (overrides: Partial<WorktreeProbe> = {}): WorktreeProbe => ({
  packageJson: { status: 'absent' },
  scripts: {},
  htmlFiles: [],
  playwrightConfigFiles: [],
  playwrightConfigContents: {},
  pythonTestSurface: { present: false, sources: [] },
  lintConfig: null,
  ...overrides,
});

describe('CHECK environment signals', () => {
  it('detects Playwright configs and e2e scripts as live-app signals', () => {
    expect(detectLiveAppSignal(probe({ playwrightConfigFiles: ['playwright.config.ts'] }))).toBe(
      'playwright.config.ts',
    );
    expect(detectLiveAppSignal(probe({ scripts: { e2e: 'playwright test' } }))).toBe("package.json script 'e2e'");
    expect(detectLiveAppSignal(probe())).toBeNull();
  });

  it('reports configs and scripts that force a headed browser', () => {
    expect(
      detectHeadedModeSignals(
        probe({
          playwrightConfigFiles: ['playwright.config.ts'],
          playwrightConfigContents: { 'playwright.config.ts': 'use: { headless: false }' },
          scripts: { headed: 'playwright test --headed', ui: 'playwright test --ui', cypress: 'cypress open' },
        }),
      ),
    ).toEqual([
      'playwright.config.ts forces headless: false',
      "package.json script 'headed' passes --headed",
      "package.json script 'ui' passes --ui",
      "package.json script 'cypress' runs 'cypress open' (interactive UI runner)",
    ]);
    expect(detectHeadedModeSignals(probe())).toEqual([]);
  });
});
