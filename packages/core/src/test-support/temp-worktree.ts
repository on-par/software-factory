import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createTempDirs } from '../harness/temp-dir.js';

export interface TempWorktrees {
  makeWorktree(files?: Readonly<Record<string, string>>): Promise<string>;
  cleanup(): Promise<void>;
}

export function createTempWorktrees(prefix: string): TempWorktrees {
  const dirs = createTempDirs();
  return {
    async makeWorktree(files = {}) {
      const dir = await dirs.make(prefix);
      for (const [path, contents] of Object.entries(files)) {
        const fullPath = join(dir, path);
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, contents);
      }
      return dir;
    },
    cleanup: () => dirs.cleanup(),
  };
}
