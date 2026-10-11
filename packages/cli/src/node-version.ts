// packages/cli/src/node-version.ts — minimum Node gate for the bin entry (#2382). No imports: must load on old Node.

/** Minimum supported Node.js major; keep in sync with engines.node (asserted by node-version.test.ts). */
export const MIN_NODE_MAJOR = 24;

export type NodeVersionCheck = { ok: true } | { ok: false; message: string };

export function checkNodeVersion(version: string): NodeVersionCheck {
  const match = /^v?(\d+)\./.exec(version);
  if (match && Number(match[1]) >= MIN_NODE_MAJOR) return { ok: true };
  const found = version === '' ? 'unknown' : match && !version.startsWith('v') ? `v${version}` : version;
  return {
    ok: false,
    message:
      `On PAR Dev's Software Factory needs Node.js ${MIN_NODE_MAJOR} or newer (found ${found}).\n` +
      `Fix: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}, then npm install -g @on-par/factory-cli`,
  };
}
