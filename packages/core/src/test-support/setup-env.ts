import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CHECK inherits its parent daemon's immutable run snapshot. Tests own their
// configuration fixtures; clear the inherited transport before importing suites.
delete process.env.FACTORY_RUN_CONFIG_JSON;
// A lane running this repo's tests with a state root must not redirect suites expecting <tmp>/.factory.
delete process.env.FACTORY_STATE_ROOT;
// Host build slots (#3043) are shared state under ~/.factory/host; tests must never touch the real home.
process.env.FACTORY_HOST_SLOTS_DIR = join(tmpdir(), `factory-test-host-slots-${process.pid}`);
