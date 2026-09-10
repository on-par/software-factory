import { describe, expect, it } from 'vitest';

import { sanitizeTerminalText } from './text.js';

describe('sanitizeTerminalText', () => {
  it('strips ANSI escapes, carriage returns, DEL and C1 controls but keeps printable unicode', () => {
    expect(sanitizeTerminalText('\x1b[2Jclear \x1b]8;;http://x\x07link\x1b]8;;\x07')).toBe(
      '[2Jclear ]8;;http://xlink]8;;',
    );
    expect(sanitizeTerminalText('row\rspoofed\nnext\x7f\x9b[31m')).toBe('rowspoofednext[31m');
    expect(sanitizeTerminalText('Fix the flaky test — “quoted” ✔')).toBe('Fix the flaky test — “quoted” ✔');
    expect(sanitizeTerminalText('')).toBe('');
  });
});
