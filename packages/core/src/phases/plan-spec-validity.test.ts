import { describe, expect, it } from 'vitest';

import { invalidPlanReason, specHasImplementation } from './plan-spec-validity.js';

describe('specHasImplementation', () => {
  it.each([
    ['missing body', '', false],
    ['empty body', ' \n\t', false],
    ['heading only', '## Files / approach', false],
    ['blank section before Tests content', '## Files / approach\n\n## Tests\nAdd test coverage.', false],
    ['blank and placeholder lines', '## Files / approach\n\n-\n- TBD\n* TODO\nN/A\nnone\n...\n…', false],
    ['decorated mixed-case placeholder', '## Files / approach\n- **tBd**.\n`TODO`!\n**TBD.**\n_ n/a _', false],
    ['angle template placeholder', '## Files / approach\n<exact files, functions, ...>', false],
    ['CRLF lines', '## Files / approach\r\nUpdate packages/core/src/phases/plan.ts\r\n', true],
    ['mixed case and slash whitespace', '##   fIlEs   /   ApPrOaCh   ###\nChange the parser.', true],
    ['substantive bullet and prose', '## Files / approach\n- Update the parser.\nAdd a regression.', true],
    ['nested heading with no content', '## Files / approach\n### Parser\n## Tests\nAdd tests.', false],
    ['nested heading with content', '## Files / approach\n### Parser\nUpdate parsePlanSpec.', true],
    ['later repeated section with content', '## Files / approach\nTBD\n## Files / approach\nUpdate the parser.', true],
    ['backtick fenced heading', '```md\n## Files / approach\nFake content\n```', false],
    ['tilde fenced heading', '~~~md\n## Files / approach\nFake content\n~~~', false],
    ['wrong-level heading', '### Files / approach\nUpdate the parser.', false],
    ['near-match heading', '## Files / approach and tests\nUpdate the parser.', false],
    ['comment-only content', '## Files / approach\n<!-- plan goes here -->\n<!-- another comment -->', false],
    ['multiline comment-only content', '## Files / approach\n<!--\nnot an implementation\n-->', false],
    ['unclosed comment hides the rest', '## Files / approach\n<!-- draft\nUpdate the parser.', false],
    ['nested comment opener', '## Files / approach\n<!-- <!-- x --> -->', true],
    ['content around a comment', '## Files / approach\n<!-- note --> Update the parser.', true],
    ['code in a real section', '## Files / approach\n```ts\nexport function parsePlanSpec() {}\n```', true],
  ])('%s', (_name, body, expected) => {
    expect(specHasImplementation(body)).toBe(expected);
  });
});

describe('invalidPlanReason', () => {
  it.each([
    [[], 3, 'invalid plan: no valid design artifact after 3 attempt(s) and the spec has no Files / approach section'],
    [
      ['one'],
      1,
      'invalid plan: no valid design artifact after 1 attempt(s) and the spec has no Files / approach section: one',
    ],
    [
      ['one', 'two', 'three'],
      2,
      'invalid plan: no valid design artifact after 2 attempt(s) and the spec has no Files / approach section: one; two; three',
    ],
    [
      ['one', 'two', 'three', 'four'],
      3,
      'invalid plan: no valid design artifact after 3 attempt(s) and the spec has no Files / approach section: one; two; three',
    ],
  ])('formats %i errors at attempt %i', (errors, attempts, expected) => {
    expect(invalidPlanReason(errors, attempts)).toBe(expected);
  });
});
