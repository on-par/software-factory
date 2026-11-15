import type { render } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import type { AppProps } from './components/App.js';
import type { followPlain } from './fallback.js';
import { runTui } from './run-tui.js';

/** runTui only reads stdout.isTTY and forwards stdout to followPlainFn; one assertion is enough. */
function fakeStdout(isTTY: boolean): NodeJS.WriteStream {
  return { isTTY } as NodeJS.WriteStream;
}

/** runTui renders exactly one element and it is always <App/>; ink's `render` types its tree as
 *  the broader ReactNode, so one assertion narrows it to the concrete element the call site
 *  passed, recovering its AppProps directly (deviates from the frozen plan's `ReactElement`
 *  parameter, which does not match ink's actual `render(node: ReactNode, ...)` signature). */
function appPropsOf(node: ReactNode): AppProps {
  return (node as ReactElement<AppProps>).props;
}

function recordFollowPlain() {
  const calls: { file: string; out: NodeJS.WritableStream }[] = [];
  let stops = 0;
  const followPlainFn: typeof followPlain = (file, out) => {
    calls.push({ file, out: out as NodeJS.WritableStream });
    return () => {
      stops += 1;
    };
  };
  return { calls, stopCount: () => stops, followPlainFn };
}

function recordRender(opts: { throws?: Error } = {}) {
  const nodes: ReactNode[] = [];
  let exits = 0;
  const renderFn: typeof render = (node) => {
    nodes.push(node);
    if (opts.throws) throw opts.throws;
    return {
      rerender: () => {},
      unmount: () => {},
      waitUntilExit: async () => {
        exits += 1;
      },
      cleanup: () => {},
      clear: () => {},
      waitUntilRenderFlush: async () => {},
    };
  };
  return { nodes, exited: () => exits, renderFn };
}

async function runTty(extra: Partial<Parameters<typeof runTui>[0]>) {
  const stdout = fakeStdout(true);
  const r = recordRender();
  const f = recordFollowPlain();
  await runTui({
    eventsFile: 'events.ndjson',
    stdout,
    render: r.renderFn,
    followPlainFn: f.followPlainFn,
    ...extra,
  });
  expect(r.nodes).toHaveLength(1);
  return appPropsOf(r.nodes[0]);
}

async function runUntilSigint(
  stdout: NodeJS.WriteStream,
  r: ReturnType<typeof recordRender>,
  f: ReturnType<typeof recordFollowPlain>,
) {
  const promise = runTui({ eventsFile: 'events.ndjson', stdout, render: r.renderFn, followPlainFn: f.followPlainFn });
  process.emit('SIGINT', 'SIGINT');
  await expect(promise).resolves.toBeUndefined();
}

describe('runTui', () => {
  it('falls back to plain printing on a non-TTY stdout, without invoking render', async () => {
    const stdout = fakeStdout(false);
    const f = recordFollowPlain();
    const r = recordRender();

    await runUntilSigint(stdout, r, f);

    expect(f.calls).toEqual([{ file: 'events.ndjson', out: stdout }]);
    expect(r.nodes).toEqual([]);
    expect(f.stopCount()).toBe(1);
  });

  it('falls back to plain printing when render throws', async () => {
    const stdout = fakeStdout(true);
    const f = recordFollowPlain();
    const r = recordRender({ throws: new Error('ink init failed') });

    await runUntilSigint(stdout, r, f);

    expect(r.nodes).toHaveLength(1);
    expect(f.calls).toEqual([{ file: 'events.ndjson', out: stdout }]);
    expect(f.stopCount()).toBe(1);
  });

  it('resolves via the Ink app exiting on a TTY stdout', async () => {
    const stdout = fakeStdout(true);
    const r = recordRender();
    const f = recordFollowPlain();

    await expect(
      runTui({ eventsFile: 'events.ndjson', stdout, render: r.renderFn, followPlainFn: f.followPlainFn }),
    ).resolves.toBeUndefined();

    expect(r.nodes).toHaveLength(1);
    expect(r.exited()).toBe(1);
    expect(f.calls).toEqual([]);
  });

  it('forwards stopFile through to the rendered App', async () => {
    const props = await runTty({ stopFile: '/repo/.factory/STOP' });
    expect(props.stopFile).toBe('/repo/.factory/STOP');
  });

  it('forwards queueReader and costsFile through to the rendered App', async () => {
    const queueReader = { source: 'GitHub', read: async () => ({ entries: [] }), pollMs: 30_000 };
    const props = await runTty({ queueReader, costsFile: '/repo/.factory/costs.jsonl' });
    expect(props.queueReader).toBe(queueReader);
    expect(props.costsFile).toBe('/repo/.factory/costs.jsonl');
  });

  it('forwards approvalsDir through to the rendered App', async () => {
    const props = await runTty({ approvalsDir: '/repo/.factory/approvals' });
    expect(props.approvalsDir).toBe('/repo/.factory/approvals');
  });

  it('forwards steeringDir through to the rendered App', async () => {
    const props = await runTty({ steeringDir: '/repo/.factory/steering' });
    expect(props.steeringDir).toBe('/repo/.factory/steering');
  });

  it('forwards breakerFile and effectiveConfigLines through to the rendered App', async () => {
    const props = await runTty({
      breakerFile: '/repo/.factory/breaker.json',
      effectiveConfigLines: ['router: default'],
    });
    expect(props.breakerFile).toBe('/repo/.factory/breaker.json');
    expect(props.effectiveConfigLines).toEqual(['router: default']);
  });
});
