// scripts/verify-env-probe.mjs — environment probe for verify.sh (#3332).
// A sandbox that denies loopback binds (Codex workspace-write) fails tests with `listen EPERM`;
// that is an environment error, not a code failure. Exit 78 with one detail line on EPERM; any other
// probe error is a warning only (exit 0) so the real test run reports real problems.
import net from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';

function probe(label, listenOpts) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => reject({ label, err }));
    server.listen(listenOpts, () => server.close(() => resolve()));
  });
}

const pipePath = join(process.env.TMPDIR || os.tmpdir(), `verify-probe-${process.pid}.sock`);
try {
  await probe('tcp 127.0.0.1', { host: '127.0.0.1', port: 0 });
  await probe(`pipe ${pipePath}`, { path: pipePath });
} catch (failure) {
  const { label, err } = failure;
  if (err && err.code === 'EPERM') {
    console.log(`EPERM: ${label}: ${err.message}`);
    process.exit(78);
  }
  console.error(`verify: env probe warning: ${err && err.code} ${err && err.message}`);
} finally {
  try {
    unlinkSync(pipePath);
  } catch {
    // the pipe may never have been created
  }
}
