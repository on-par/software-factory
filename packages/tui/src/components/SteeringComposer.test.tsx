import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { SteeringComposer } from './SteeringComposer.js';

afterEach(cleanup);

describe('SteeringComposer', () => {
  it('shows the issue number, the draft text, and the send/cancel hint', () => {
    const { lastFrame } = render(<SteeringComposer issue="296" draft="use approach B" missingPaths={[]} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Steer issue #296');
    expect(frame).toContain('use approach B');
    expect(frame).toContain('Enter send · Esc cancel');
  });

  it('omits the warning line when there are no missing paths', () => {
    const { lastFrame } = render(<SteeringComposer issue="296" draft="use approach B" missingPaths={[]} />);
    expect(lastFrame()).not.toContain('not found in worktree');
  });

  it('shows the warning line listing missing paths', () => {
    const { lastFrame } = render(
      <SteeringComposer issue="296" draft="see packages/x.ts" missingPaths={['packages/x.ts']} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('⚠ not found in worktree: packages/x.ts');
    expect(frame).toContain('Enter again to send anyway');
  });
});
