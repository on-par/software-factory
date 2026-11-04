// packages/core/src/queue/prerequisite-stack.test.ts — cross-issue stack chooser and body marker (#3916).

import { describe, expect, it } from 'vitest';

import {
  choosePrerequisiteStack,
  parsePrerequisiteStackMarker,
  renderPrerequisiteStackMarker,
  resolveQueueStackOnOpenPrerequisite,
  type PrerequisiteStackTarget,
} from './prerequisite-stack.js';
import { defaultFactoryConfig } from '@on-par/factory-config';

const target = (issue: number, c = 'a'): PrerequisiteStackTarget => ({
  issue,
  prNumber: issue * 10,
  branch: `factory/${issue}-x`,
  headSha: c.repeat(40),
});

describe('choosePrerequisiteStack', () => {
  it('stacks on the only open prerequisite', async () => {
    const t = target(5);
    expect(await choosePrerequisiteStack([t], async () => false)).toEqual({ kind: 'stack', on: t });
  });

  it('stacks on the tip when one prerequisite contains the other', async () => {
    const [low, tip] = [target(5, 'a'), target(6, 'b')];
    const contains = async (sha: string, branch: string) => branch === tip.branch && sha === low.headSha;
    expect(await choosePrerequisiteStack([low, tip], contains)).toEqual({ kind: 'stack', on: tip });
  });

  it('defers when open prerequisites are unrelated', async () => {
    const out = await choosePrerequisiteStack([target(5, 'a'), target(6, 'b')], async () => false);
    expect(out).toMatchObject({ kind: 'defer' });
    expect(out.kind === 'defer' && out.reason).toContain('#5, #6');
  });
});

describe('prerequisite stack marker', () => {
  it('round-trips', () => {
    const t = target(5, 'c');
    expect(parsePrerequisiteStackMarker(`## Summary\n\nx\n${renderPrerequisiteStackMarker(t)}\nmore`)).toEqual(t);
  });

  it.each([
    ['no marker', 'nothing here'],
    ['non-factory branch', '<!-- factory:prerequisite-stack issue:5 pr:50 branch:main head:' + 'a'.repeat(40) + ' -->'],
    [
      'branch for another issue',
      '<!-- factory:prerequisite-stack issue:5 pr:50 branch:factory/6-x head:' + 'a'.repeat(40) + ' -->',
    ],
    ['short sha', '<!-- factory:prerequisite-stack issue:5 pr:50 branch:factory/5-x head:abc123 -->'],
    [
      'uppercase sha',
      '<!-- factory:prerequisite-stack issue:5 pr:50 branch:factory/5-x head:' + 'A'.repeat(40) + ' -->',
    ],
  ])('rejects %s', (_name, body) => {
    expect(parsePrerequisiteStackMarker(body)).toBeUndefined();
  });
});

describe('resolveQueueStackOnOpenPrerequisite', () => {
  it('defaults on and honours false', () => {
    expect(resolveQueueStackOnOpenPrerequisite(defaultFactoryConfig as never)).toBe(true);
    expect(resolveQueueStackOnOpenPrerequisite({ queue: { stackOnOpenPrerequisite: false } } as never)).toBe(false);
  });
});
