import type { SimRecordedCall } from './octokit.js';

export type FakeOctokitHandler = (...args: any[]) => unknown;

export type FakeOctokitResponses = Record<string, unknown>;

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
