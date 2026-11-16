export interface IssueCallArgs {
  issue_number: number;
  name?: string;
  labels?: string[];
}

export const record = <A = IssueCallArgs>(result: unknown = {}): ((arg: A) => Promise<unknown>) & { calls: A[] } => {
  const calls: A[] = [];
  return Object.assign(
    async (arg: A) => {
      calls.push(arg);
      return result;
    },
    { calls },
  );
};
