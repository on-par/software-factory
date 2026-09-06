import { spawn, type ChildProcess } from 'node:child_process';
import { recordOwnedProcess } from '../daemon/process-ownership.js';

// Keep the process-group owner alive after the shell exits: background servers
// still belong to it until normal lane cleanup or the CLI-parent watchdog kills
// the group. IPC reports the shell result without ending the ownership lifetime.
const supervisor = `
const { spawn } = require('node:child_process');
const parent = Number(process.env.FACTORY_EXEC_PARENT);
process.on('disconnect', () => process.kill(-process.pid, 'SIGKILL'));
const report = result => { if (process.connected) process.send({ factoryExit: result }, () => {}); else process.kill(-process.pid, 'SIGKILL'); };
setInterval(() => { if (process.ppid !== parent) process.kill(-process.pid, 'SIGKILL'); }, 100);
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (input !== 'go\\n') process.exit(1);
  const specification = JSON.parse(process.argv[1]);
  const command = Array.isArray(specification) ? spawn(specification[0], specification.slice(1), { stdio: ['ignore', 'inherit', 'inherit'] }) : spawn(specification, { shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
  command.on('error', error => { console.error(error.message); report({ code: -1, signal: null }); });
  command.on('exit', (code, signal) => report({ code, signal }));
});
`;
export function spawnSupervisedCommand(
  cmd: string | readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; ownershipFile: string },
): ChildProcess {
  const child = spawn(process.execPath, ['-e', supervisor, JSON.stringify(cmd)], {
    detached: true,
    cwd: options.cwd,
    env: { ...options.env, FACTORY_EXEC_PARENT: String(process.pid) },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
  });
  child.stdin?.on('error', () => {});
  child.once('spawn', () => {
    try {
      recordOwnedProcess(options.ownershipFile, child.pid!);
      child.stdin?.end('go\n');
    } catch (error) {
      child.kill('SIGKILL');
      child.emit('error', error);
    }
  });
  return child;
}
