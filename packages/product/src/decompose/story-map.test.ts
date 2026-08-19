// packages/product/src/decompose/story-map.test.ts (#633).

import { describe, expect, it } from 'vitest';

import type { IntentDoc, IntentStatement } from '../intent/index.js';
import { buildStoryMap, stagesMatching } from './story-map.js';

function statement(id: string, dimension: IntentStatement['dimension'], text: string): IntentStatement {
  return { id: id as IntentStatement['id'], dimension, text, source: 'answer' };
}

function doc(statements: IntentStatement[]): IntentDoc {
  return { brainDump: 'x', statements, gaps: [], status: 'approved' };
}

describe('stagesMatching', () => {
  it('returns catalog-ordered stages for text spanning multiple stages', () => {
    const stages = stagesMatching('upload the file and export the report');
    expect(stages.map((s) => s.id)).toEqual(['capture', 'deliver', 'learn']);
  });

  it('returns an empty array for text with no cue', () => {
    expect(stagesMatching('zzzzz nothing matches here')).toEqual([]);
  });

  it('never returns the terminal other stage', () => {
    expect(stagesMatching('upload the file and export the report').some((s) => s.id === 'other')).toBe(false);
    expect(stagesMatching('nothing at all matches')).toEqual([]);
  });
});

describe('buildStoryMap', () => {
  it('places each scope statement on its earliest matching stage, preserving doc order in scopeIds', () => {
    const d = doc([
      statement('INT-SCOPE-01', 'scope', 'search for open items'),
      statement('INT-SCOPE-02', 'scope', 'find and browse the list'),
    ]);
    const { backbone } = buildStoryMap(d);
    const discover = backbone.find((step) => step.stage.id === 'discover');
    expect(discover?.scopeIds).toEqual(['INT-SCOPE-01', 'INT-SCOPE-02']);
  });

  it('compacts ranks 1..n over only the stages present, skipping stages with nothing on them', () => {
    const d = doc([
      statement('INT-SCOPE-01', 'scope', 'sign in with sso'),
      statement('INT-SCOPE-02', 'scope', 'export the finished summary'),
    ]);
    const { backbone } = buildStoryMap(d);
    expect(backbone.map((step) => step.stage.id)).toEqual(['access', 'deliver']);
    expect(backbone.map((step) => step.rank)).toEqual([1, 2]);
  });

  it('admits a stage to the backbone via an outcome mention, with empty scopeIds', () => {
    const d = doc([
      statement('INT-SCOPE-01', 'scope', 'sign in with sso'),
      statement('INT-OUTCOME-01', 'outcome', 'a clear audit history for compliance'),
    ]);
    const { backbone } = buildStoryMap(d);
    const learn = backbone.find((step) => step.stage.id === 'learn');
    expect(learn).toBeDefined();
    expect(learn?.scopeIds).toEqual([]);
  });

  it('lands a scope statement matching no cue on the other step, which ranks last', () => {
    const d = doc([
      statement('INT-SCOPE-01', 'scope', 'sign in with sso'),
      statement('INT-SCOPE-02', 'scope', 'zzzzz nothing matches here'),
    ]);
    const { backbone } = buildStoryMap(d);
    const other = backbone.find((step) => step.stage.id === 'other');
    expect(other).toBeDefined();
    expect(other?.scopeIds).toEqual(['INT-SCOPE-02']);
    expect(other?.rank).toBe(backbone.length);
  });

  it('returns an empty backbone for a doc with no scope or outcome statements', () => {
    const d = doc([statement('INT-PROBLEM-01', 'problem', 'the export breaks weekly')]);
    expect(buildStoryMap(d).backbone).toEqual([]);
  });
});
