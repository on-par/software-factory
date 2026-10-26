import type { FactoryEvent } from '@on-par/factory-core';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { EventFeed } from './EventFeed.js';

afterEach(cleanup);

describe('EventFeed', () => {
  it('EventFeed strips terminal escapes from event text (#1634)', () => {
    const event: FactoryEvent = {
      ts: '2026-01-01T00:00:00.000Z',
      type: 'plan',
      issue: '1',
      msg: 'title \x1b]0;pwned\x07 end',
    };
    const { lastFrame } = render(<EventFeed events={[event]} />);
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('\x1b]');
    expect(frame).not.toContain('\x07');
    expect(frame).toContain(']0;pwned');
  });
});
