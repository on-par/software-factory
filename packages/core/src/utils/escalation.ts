export function isEscalation(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('ESCALATE:'));
}

export function escalationLine(output: string): string | undefined {
  return output.split('\n').find((line) => line.startsWith('ESCALATE:'));
}
