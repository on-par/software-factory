// packages/product/src/export/render.test.ts (#476).

import { describe, expect, it } from 'vitest';

import type { GitHubExportResult } from './github.js';
import { renderExportResult } from './render.js';

describe('renderExportResult', () => {
  it('renders the epic and stories with urls when present', () => {
    const result: GitHubExportResult = {
      epic: { kind: 'epic', title: 'Epic', number: 1, url: 'https://github.com/on-par/widgets/issues/1' },
      stories: [{ kind: 'story', title: 'Story One', number: 2, url: 'https://github.com/on-par/widgets/issues/2' }],
      bundleComments: 3,
    };

    const lines = renderExportResult(result);

    expect(lines).toContain('# Export');
    expect(lines).toContain('Epic: #1 Epic (https://github.com/on-par/widgets/issues/1)');
    expect(lines).toContain('- Story: #2 Story One (https://github.com/on-par/widgets/issues/2)');
    expect(lines).toContain('Bundle: 3 file(s) attached to the epic issue.');
  });

  it('renders the epic and stories without a url suffix when absent', () => {
    const result: GitHubExportResult = {
      epic: { kind: 'epic', title: 'Epic', number: 1 },
      stories: [{ kind: 'story', title: 'Story One', number: 2 }],
      bundleComments: 1,
    };

    const lines = renderExportResult(result);

    expect(lines).toContain('Epic: #1 Epic');
    expect(lines).toContain('- Story: #2 Story One');
  });

  it('renders zero stories and zero bundle files', () => {
    const result: GitHubExportResult = {
      epic: { kind: 'epic', title: 'Epic', number: 1 },
      stories: [],
      bundleComments: 0,
    };

    const lines = renderExportResult(result);

    expect(lines.filter((l) => l.startsWith('- Story:'))).toHaveLength(0);
    expect(lines).toContain('Bundle: 0 file(s) attached to the epic issue.');
  });
});
