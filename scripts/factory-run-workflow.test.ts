import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../.github/workflows/factory-run.yml', import.meta.url), 'utf8');
const lines = workflow.split('\n').map((line) => line.trim());

describe('.github/workflows/factory-run.yml', () => {
  it('uploads .factory/state/events.ndjson in the factory-run-log artifact', () => {
    const name = lines.findIndex((line) => line === 'name: factory-run-log');
    expect(name).toBeGreaterThanOrEqual(0);
    const upload = lines.slice(name, name + 6);
    expect(upload).toContain('.factory/state/events.ndjson');
    expect(lines).not.toContain('.factory/events.ndjson');
  });
});
