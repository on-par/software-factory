import { describe, expect, it } from 'vitest';

import { workKeyFromIssue } from '../work/work-key.js';
import { parkPayload, readParkState, renderParkComment, type ParkCommentInput } from './park-comment.js';

const K7 = workKeyFromIssue(7);

describe('design-smell finding (#1513)', () => {
  const F = { approachTried: 'cache it', whyItStinks: 'stale <!-- x -->reads', recommendation: 'split the module' };
  const base: ParkCommentInput = { issue: K7, reason: 'escalate', message: 'm', runId: 'r', branch: 'b' };

  it('parkPayload includes designSmell only when given', () => {
    expect(parkPayload('escalate', K7, 'app', [], F).designSmell).toEqual(F);
    expect('designSmell' in parkPayload('escalate', K7, 'app', [])).toBe(false);
  });

  it('renderParkComment renders the design-smell finding section (#1513)', () => {
    const body = renderParkComment({ ...base, designSmell: F });
    expect(body).toContain('**Design-smell finding**');
    expect(body).toContain('cache it');
    expect(body).toContain('stale reads');
    expect(body).not.toContain('<!-- x -->');
    expect(body).toContain('split the module');
    expect(body.indexOf('**Design-smell finding**')).toBeLessThan(body.indexOf('**What unblocks this:**'));
    expect(readParkState([{ id: 1, body }], K7)).toMatchObject({ reason: 'escalate' });
  });

  it('omits the section without a finding', () => {
    expect(renderParkComment(base)).not.toContain('Design-smell finding');
  });
});
