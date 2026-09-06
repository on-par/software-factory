import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { waitForOwnedProcesses } from './process-ownership.js';
import type { RunExecutor } from './run-runtime.js';

// This supervisor has its own event loop, so a blocked provider cannot delay
// noticing that the daemon died. Its group is killed by its own identity;
// recovery never sends a signal to a persisted, potentially reused PID.
const launcher = `
const { spawn } = require('node:child_process');
const parent = Number(process.env.FACTORY_DAEMON_PARENT);
const watchdog = setInterval(() => {
  if (process.ppid !== parent) process.kill(-process.pid, 'SIGKILL');
}, 100);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (input !== 'go\\n') process.exit(1);
  const cli = spawn(process.execPath, [process.argv[1], 'ship', process.argv[2]], { stdio: ['ignore', 'inherit', 'inherit'] });
  cli.on('error', error => { console.error(error.message); process.exit(1); });
  cli.on('exit', code => { clearInterval(watchdog); process.exit(code === null ? 1 : code); });
});
`;

/** Runs only the installed ship command. A detached POSIX process group lets
 * cancellation terminate provider grandchildren as well as the CLI itself. */
export function createShipExecutor(options: {
  cliEntrypoint: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
}): RunExecutor {
  return ({ run, cwd, signal, output, started, ownershipFile }) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) {
        resolve({ exitCode: null, prUrl: null });
        return;
      }
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        FACTORY_HEADLESS: '1',
        PLAYWRIGHT_HEADLESS: '1',
        FACTORY_RUN_ID: run.runId,
        FORCE_COLOR: '0',
        FACTORY_DAEMON_PARENT: String(process.pid),
      };
      if (ownershipFile) env.FACTORY_DAEMON_GROUPS_FILE = ownershipFile;
      else delete env.FACTORY_DAEMON_GROUPS_FILE;
      delete env.FACTORY_MERGE;
      delete env.FACTORY_MERGE_ADMIN;
      const child = spawn(process.execPath, ['-e', launcher, options.cliEntrypoint, String(run.issue)], {
        cwd,
        env,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let tail = '';
      const capture = (text: string) => {
        output(text);
        tail = (tail + text).slice(-8192);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let terminated = false;
      let launchError: unknown;
      const kill = (kind: NodeJS.Signals) => {
        try {
          if (child.pid && process.platform !== 'win32') process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch {
          /* The process group may already have exited. */
        }
      };
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), options.terminationGraceMs ?? 5000);
      };
      const timeout = setTimeout(
        () => {
          output('\nRun exceeded its execution deadline.\n');
          terminate();
        },
        options.timeoutMs ?? 2 * 60 * 60_000,
      );
      signal.addEventListener('abort', terminate, { once: true });
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        signal.removeEventListener('abort', terminate);
      };
      child.stdin.on('error', () => {}); // Child exit may race the durable acknowledgement.
      child.once('spawn', () => {
        void Promise.resolve()
          .then(() => started?.(child.pid!))
          .then(() => {
            if (!terminated) child.stdin.end('go\n');
          })
          .catch((error) => {
            launchError = error;
            terminate();
          });
      });
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('close', (exitCode) => {
        void (async () => {
          if (terminated) kill('SIGKILL');
          cleanup();
          if (launchError) {
            reject(launchError);
            return;
          }
          if (ownershipFile && !(await waitForOwnedProcesses(ownershipFile, options.terminationGraceMs ?? 5000))) {
            resolve({ exitCode: null, prUrl: null });
            return;
          }
          if (ownershipFile) await rm(ownershipFile, { force: true });
          const terminal = stripVTControlCharacters(tail)
            .split('\n')
            .reverse()
            .find((line) => line.startsWith(`✅ Issue #${run.issue} → PR #`));
          const pr = terminal?.match(/→ PR #(\d+) ready for review\s*$/)?.[1];
          resolve({
            exitCode: terminated ? null : exitCode,
            prUrl: !terminated && exitCode === 0 && pr ? `https://github.com/${run.repo}/pull/${pr}` : null,
          });
        })().catch(reject);
      });
    });
}
