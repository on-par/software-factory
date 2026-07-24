import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const LANES = 8;
const EVENTS_PER_LANE = 125;

function runChild(childPath: string, eventsFile: string, lane: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', childPath, eventsFile, lane], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stderr }));
  });
}

describe('concurrent logger appends across processes', () => {
  it('serializes appends from 8 concurrent processes with no torn or lost lines', { timeout: 60_000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'factory-logger-concurrency-'));
    try {
      const eventsFile = join(tmpDir, 'events.ndjson');
      const childPath = join(tmpDir, 'child.ts');
      const loggerSpecifier = pathToFileURL(join(repoRoot, 'packages/core/src/logger/index.ts')).href;

      await writeFile(
        childPath,
        `import { createLogger } from '${loggerSpecifier}';
const [eventsFile, lane] = process.argv.slice(2);
const logger = createLogger(eventsFile, { lane }, { out: { write: () => {} } });
for (let i = 0; i < ${EVENTS_PER_LANE}; i++) logger.info('concurrency', \`\${lane}-event-\${i}\`);
`,
      );

      const results = await Promise.all(
        Array.from({ length: LANES }, (_, n) => runChild(childPath, eventsFile, `lane-${n}`)),
      );

      for (const result of results) {
        expect(result.code, `child exited non-zero, stderr:\n${result.stderr}`).toBe(0);
      }

      const content = await readFile(eventsFile, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(LANES * EVENTS_PER_LANE);

      const seen = new Set<string>();
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(Object.keys(parsed).sort()).toEqual(['issue', 'lane', 'level', 'msg', 'ts', 'type']);
        const match = /^lane-(\d+)-event-(\d+)$/.exec(parsed.msg);
        expect(match).not.toBeNull();
        const [, laneNum, eventNum] = match!;
        expect(parsed.lane).toBe(`lane-${laneNum}`);
        seen.add(`${laneNum}:${eventNum}`);
      }

      const expected = new Set<string>();
      for (let lane = 0; lane < LANES; lane++) {
        for (let i = 0; i < EVENTS_PER_LANE; i++) {
          expected.add(`${lane}:${i}`);
        }
      }
      expect(seen).toEqual(expected);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
