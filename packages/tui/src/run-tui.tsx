import { render } from 'ink';

import { App, type QueueReader } from './components/App.js';
import { followPlain } from './fallback.js';

export interface RunTuiOptions {
  eventsFile: string;
  repo?: string;
  stopFile?: string;
  queueReader?: QueueReader;
  costsFile?: string;
  approvalsDir?: string;
  steeringDir?: string;
  breakerFile?: string;
  effectiveConfigLines?: string[];
  stdout?: NodeJS.WriteStream;
  render?: typeof render;
  followPlainFn?: typeof followPlain;
}

function runPlain(eventsFile: string, stdout: NodeJS.WriteStream, followPlainFn: typeof followPlain): Promise<void> {
  return new Promise((resolve) => {
    const stop = followPlainFn(eventsFile, stdout);
    const finish = () => {
      stop();
      resolve();
    };
    process.once('SIGINT', finish);
    process.stdin.once('end', finish);
  });
}

export async function runTui(opts: RunTuiOptions): Promise<void> {
  const {
    eventsFile,
    repo,
    stopFile,
    queueReader,
    costsFile,
    approvalsDir,
    steeringDir,
    breakerFile,
    effectiveConfigLines,
    stdout = process.stdout,
    render: renderFn = render,
    followPlainFn = followPlain,
  } = opts;

  if (!stdout.isTTY) {
    await runPlain(eventsFile, stdout, followPlainFn);
    return;
  }

  try {
    const app = renderFn(
      <App
        eventsFile={eventsFile}
        repo={repo}
        stopFile={stopFile}
        queueReader={queueReader}
        costsFile={costsFile}
        approvalsDir={approvalsDir}
        steeringDir={steeringDir}
        breakerFile={breakerFile}
        effectiveConfigLines={effectiveConfigLines}
      />,
      { exitOnCtrlC: true },
    );
    await app.waitUntilExit();
  } catch {
    await runPlain(eventsFile, stdout, followPlainFn);
  }
}
