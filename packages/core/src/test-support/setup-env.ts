import { mkdtempSync, writeFileSync } from 'node:fs';
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
// mkdtemp gives each worker its own 0700 dir, so no other user can plant a binary on our PATH.
// setupFiles re-run per test file in a reused worker, so make the dir once per process.
if (!process.env.FACTORY_TEST_FAKE_BIN) {
  const scratchRoot = sandbox || tmpdir();
  const fakeBin = mkdtempSync(join(scratchRoot, 'factory-test-fake-bin-'));
  writeFileSync(join(fakeBin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  process.env.FACTORY_TEST_FAKE_BIN = fakeBin;
  process.env.PATH = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`;
}
