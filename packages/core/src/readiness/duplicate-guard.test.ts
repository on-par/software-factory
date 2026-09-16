// src/readiness/duplicate-guard.test.ts — Jaccard duplicate-story matching tests (#1502).
import { describe, expect, it } from 'vitest';

import {
  DECOMPOSITION_DUPLICATE_THRESHOLD,
  decompositionTextSimilarity,
  findDuplicateStory,
} from './duplicate-guard.js';

const retryJobsText =
  'Retry failed import jobs failed import jobs retry automatically so transient failures do not lose work';
const instrumentQueueText =
  'Instrument queue throughput queue throughput is visible so operators can spot stalls early';

describe('decompositionTextSimilarity', () => {
  it('scores identical text as 1', () => {
    expect(decompositionTextSimilarity(retryJobsText, retryJobsText)).toBe(1);
  });

  it('returns 0 for an empty string on either side', () => {
    expect(decompositionTextSimilarity('', instrumentQueueText)).toBe(0);
    expect(decompositionTextSimilarity(instrumentQueueText, '')).toBe(0);
  });

  it('scores unrelated text below the duplicate threshold', () => {
    expect(decompositionTextSimilarity(retryJobsText, instrumentQueueText)).toBeLessThan(
      DECOMPOSITION_DUPLICATE_THRESHOLD,
    );
  });

  it('is case- and punctuation-insensitive', () => {
    expect(decompositionTextSimilarity('Retry Failed Import Jobs!', 'retry failed import jobs')).toBe(1);
  });
});

describe('findDuplicateStory', () => {
  const siblings = [
    { number: 901, title: 'Retry failed import jobs', body: 'Add a bounded retry with backoff for import jobs.' },
    { number: 902, title: 'Instrument queue throughput', body: 'Expose queue depth metrics.' },
  ];

  it('finds the closely matching sibling and reports its similarity', () => {
    const duplicate = findDuplicateStory(
      'Retry failed import jobs Add a bounded retry with backoff for import jobs.',
      siblings,
    );

    expect(duplicate).toMatchObject({ number: 901, title: 'Retry failed import jobs' });
    expect(duplicate?.similarity).toBeGreaterThanOrEqual(DECOMPOSITION_DUPLICATE_THRESHOLD);
  });

  it('returns undefined when no sibling clears the threshold', () => {
    expect(findDuplicateStory('Refactor the billing invoice renderer for tax rounding', siblings)).toBeUndefined();
  });

  it('returns undefined for an empty sibling list', () => {
    expect(findDuplicateStory('Retry failed import jobs', [])).toBeUndefined();
  });

  it('ignores a sibling whose body is null', () => {
    const duplicate = findDuplicateStory('Retry failed import jobs', [{ number: 903, title: '', body: null }]);

    expect(duplicate).toBeUndefined();
  });

  it('picks the highest-similarity sibling when more than one clears the threshold', () => {
    const closeSiblings = [
      { number: 1, title: 'Retry failed import jobs', body: 'partial match only' },
      { number: 2, title: 'Retry failed import jobs', body: 'Add a bounded retry with backoff for import jobs.' },
    ];

    const duplicate = findDuplicateStory(
      'Retry failed import jobs Add a bounded retry with backoff for import jobs.',
      closeSiblings,
    );

    expect(duplicate?.number).toBe(2);
  });
});
