// src/checkers/rework-history.ts — Cross-run failure-signature memory (#740).
//
// checkPhase's in-run "stuck" detection (packages/core/src/phases/check.ts)
// only compares failure signatures across rework rounds within ONE process —
// it resets to nothing the moment that process exits. A watchdog that relaunches
// a dead session every ~10 minutes (relaunch-if-dead.sh, run by every repo's
// factory cron) has no idea a lane already burned its full rework budget
// hitting this exact failure last time: it just sees a dead tmux session and
// blindly restarts the whole queue, which walks straight back into the same
// parked lane and burns another 3 rework rounds against a root cause nothing
// has fixed yet.
//
// ReworkHistory closes that gap: a small file-backed record of the last
// failure signature each issue parked/got stuck on, keyed by issue number.
// checkPhase reads it before starting the rework loop; if round one's
// signature already matches, it skips the rework loop entirely (0 rounds
// burned) and reports `crossRunStuck: true` instead of quietly retrying.

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

  /** Signature this issue parked/got stuck on last time, or undefined if none recorded. */
  async priorSignature(issue: number): Promise<string | undefined> {
    const data = await this.read();
    return data.issues[String(issue)]?.signature;
  }

  /** Records the failing-checks signature this run ended on. Upserts (refreshes recordedAt). */
  async record(issue: number, signature: string, failingChecks: string[]): Promise<void> {
    const data = await this.read();
    data.issues[String(issue)] = { signature, failingChecks, recordedAt: new Date(this.now()).toISOString() };
    await this.write(data);
  }

  /** Clears an issue's entry — call once it ships/merges or a check run passes clean. */
  async clear(issue: number): Promise<void> {
    const data = await this.read();
    if (!(String(issue) in data.issues)) return;
    delete data.issues[String(issue)];
    await this.write(data);
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
    // Two lanes racing on the same issue is not a real scenario (queue owns
    // exclusivity), but a stray concurrent write would at worst overwrite this
    // issue's entry — benign, matches ProviderBreaker's no-lock rationale.
    await rename(tmp, this.file);
  }
}
