export const recordArgs = <A extends unknown[], R>(impl: (...args: A) => R) => {
  const calls: A[] = [];
  return { calls, fn: (...args: A): R => impl(...(calls.push(args), args)) };
};
