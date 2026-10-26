// src/reports/evidence-pack-model-pins.test.ts — model pins section, split out of evidence-pack.test.ts

import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { renderEvidencePack } from './evidence-pack.js';

describe('renderEvidencePack — model pins (#2511)', () => {
  it('lists an overridden pin and omits the section otherwise', () => {
    const note = 'build pin gpt-build not used (usage_cap); built with claude-sonnet-5';
    const withNote = renderEvidencePack({ issue: workKeyFromIssue(1), events: [], logFiles: [], pinNotes: [note] });
    expect(withNote).toContain('Model pins');
    expect(withNote).toContain(note);
    expect(renderEvidencePack({ issue: workKeyFromIssue(1), events: [], logFiles: [] })).not.toContain('Model pins');
  });
});
