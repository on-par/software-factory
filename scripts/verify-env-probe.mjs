// Loopback/TMPDIR pipe bind probe for verify.sh (#3332). Exits 78 only when a bind fails with EPERM;
// any other error is noted on stderr and ignored so a flaky host never stops verify.sh.
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function probe(target, listenArgs) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (err) => {
      if (err && err.code === 'EPERM') {
        process.stderr.write(`verify: probe: ${target} listen EPERM\n`);
        process.exit(78);
      }
      process.stderr.write(`verify: probe: ${target} ${err && err.code} (ignored)\n`);
      resolve();
    });
    server.listen(...listenArgs, () => server.close(() => resolve()));
  });
}

await probe('127.0.0.1', [0, '127.0.0.1']);
const socketPath = join(tmpdir(), `verify-probe-${process.pid}.sock`);
try {
  await probe(socketPath, [socketPath]);
} finally {
  rmSync(socketPath, { force: true });
}
