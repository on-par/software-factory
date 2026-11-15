import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ReworkHistoryEntry {
  signature: string;
  failingChecks: string[];
  recordedAt: string;
}

interface ReworkHistoryFile {
  version: 1;
  issues: Record<string, ReworkHistoryEntry>;
}

export class ReworkHistory {
  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  async priorSignature(issue: number): Promise<string | undefined> {
    const data = await this.read();
    return data.issues[String(issue)]?.signature;
  }

  async record(issue: number, signature: string, failingChecks: string[]): Promise<void> {
    const data = await this.read();
    data.issues[String(issue)] = { signature, failingChecks, recordedAt: new Date(this.now()).toISOString() };
    await this.write(data);
  }

  async clear(issue: number): Promise<boolean> {
    const data = await this.read();
    if (!(String(issue) in data.issues)) return false;
    delete data.issues[String(issue)];
    await this.write(data);
    return true;
  }

  private async read(): Promise<ReworkHistoryFile> {
    try {
      const raw = await readFile(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ReworkHistoryFile>;
      return { version: 1, issues: parsed.issues ?? {} };
    } catch {
      return { version: 1, issues: {} };
    }
  }

  private async write(data: ReworkHistoryFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, this.file);
  }
}
