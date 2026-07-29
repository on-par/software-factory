import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PIN_PATH = fileURLToPath(new URL('../scbench.pin.json', import.meta.url));

describe('scbench.pin.json', () => {
  it('parses and pins a well-formed upstream repo + full-length commit SHA', () => {
    const pin = JSON.parse(readFileSync(PIN_PATH, 'utf-8'));

    expect(pin.repo).toBe('https://github.com/SprocketLab/slop-code-bench');
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof pin.pinnedAt).toBe('string');
  });
});
