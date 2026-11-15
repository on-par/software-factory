import { expect, it } from 'vitest';

export function recorder<A extends unknown[] = unknown[], R = void>(impl?: (...args: A) => R) {
  const calls: A[] = [];
  const fn = (...args: A): R => {
    calls.push(args);
    return impl?.(...args) as R;
  };
  return Object.assign(fn, { calls });
}

if (expect.getState().testPath === import.meta.filename) {
  it('records each call and returns what the implementation returns', () => {
    const double = recorder((n: number) => n * 2);
    expect(double(4)).toBe(8);
    expect(double.calls).toEqual([[4]]);
  });
}
