import type { SimRecordedCall } from '../sim/index.js';

export type FakeOctokitHandler = (...args: any[]) => unknown;

/**
 * Keys are dotted endpoint paths under `rest` (`'issues.get'`, `'pulls.list'`, ...) or a bare name
 * (`'graphql'`, `'paginate'`, `'request'`) mounted directly on the octokit. A function value is a handler
 * (its return value, sync or a promise, is what the endpoint resolves to; a throw rejects). Any other value
 * is returned as is, so REST callers include their own `{ data }` wrapper.
 */
export type FakeOctokitResponses = Record<string, unknown>;

/** Build a fake Octokit from per-endpoint responses and record every call. Unconfigured endpoints stay undefined. */
export function fakeOctokit(responses: FakeOctokitResponses = {}): { octokit: any; calls: SimRecordedCall[] } {
  const calls: SimRecordedCall[] = [];
  const octokit: any = {};
  for (const [key, response] of Object.entries(responses)) {
    const respond = async (args: unknown[]): Promise<unknown> =>
      typeof response === 'function' ? (response as FakeOctokitHandler)(...args) : response;
    if (!key.includes('.')) {
      octokit[key] = async (...args: unknown[]) => {
        calls.push([key, ...args]);
        return respond(args);
      };
      continue;
    }
    const [namespace, method] = key.split('.');
    octokit.rest ??= {};
    octokit.rest[namespace] ??= {};
    octokit.rest[namespace][method] = async (...args: unknown[]) => {
      calls.push([key, ...args]);
      return respond(args);
    };
  }
  return { octokit, calls };
}
