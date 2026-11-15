import { vi } from 'vitest';

export function captureConsole(method: 'log' | 'error', lines: string[]) {
  lines.length = 0;
  const spy: any = vi.spyOn(console, method).mockImplementation((...a: unknown[]) => lines.push(a.join(' ')));
  const mockClear = spy.mockClear.bind(spy);
  spy.mockClear = () => {
    lines.length = 0;
    return mockClear();
  };
  return spy;
}
