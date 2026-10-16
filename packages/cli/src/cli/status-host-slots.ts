// packages/cli/src/cli/status-host-slots.ts — the `factory status` Host slots section (#3045).
import type { HostSlotStatus } from '@on-par/factory-core/internal';

/** Lines under `== Host slots ==`: one per slot file, then `builds <live>/<max> in use`. */
export function formatHostSlotsSection(slots: readonly HostSlotStatus[], maxBuilds: number): string[] {
  const lines: string[] = [];
  if (slots.length === 0) lines.push('  (no host slots in use)');
  for (const s of slots) {
    if (s.unreadable) {
      lines.push(`  slot ${s.slot}  (unreadable lease file)`);
      continue;
    }
    const base = `  slot ${s.slot}  ${s.phase}  ${s.repo}#${s.issue}  pid ${s.pid}`;
    lines.push(s.stale ? `${base}  (stale — holder pid not alive)` : base);
  }
  lines.push(`  builds ${slots.filter((s) => !s.stale).length}/${maxBuilds} in use`);
  return lines;
}
