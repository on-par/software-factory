import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    factoryTmpSandbox: string;
  }
}

// Every test (and every subprocess it spawns) makes scratch dirs inside one per-run sandbox that
// scripts/test-tmp-sandbox.ts removes when the run ends, so leaked dirs never pile up in TMPDIR (#3114).
const sandbox = inject('factoryTmpSandbox');
if (sandbox) {
  process.env.TMPDIR = sandbox;
  process.env.TMP = sandbox;
  process.env.TEMP = sandbox;
}

// CHECK inherits its parent daemon's immutable run snapshot. Tests own their
// configuration fixtures; clear the inherited transport before importing suites.
delete process.env.FACTORY_RUN_CONFIG_JSON;
// A lane running this repo's tests with a state root must not redirect suites expecting <tmp>/.factory.
delete process.env.FACTORY_STATE_ROOT;
// Host build slots (#3043) are shared state under ~/.factory/host; tests must never touch the real home.
process.env.FACTORY_HOST_SLOTS_DIR = join(tmpdir(), `factory-test-host-slots-${process.pid}`);

// Tests must never launch the developer's real codex: the router's login probe runs `codex login status`, and a
// quarantined Homebrew codex shows a macOS "open this app?" dialog on every launch. A fake that exits 1 reads as
// installed but not logged in. Suites that need a scripted codex prepend their own fixture bin, which wins.
const fakeBin = join(sandbox || tmpdir(), 'factory-test-fake-bin');
mkdirSync(fakeBin, { recursive: true });
const staged = join(fakeBin, `codex.${process.pid}`);
writeFileSync(staged, '#!/bin/sh\nexit 1\n');
chmodSync(staged, 0o755);
renameSync(staged, join(fakeBin, 'codex'));
if (!(process.env.PATH ?? '').split(delimiter).includes(fakeBin)) {
  process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
}
