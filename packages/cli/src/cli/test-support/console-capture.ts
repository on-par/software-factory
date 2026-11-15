import { vi } from 'vitest';

export function captureConsole(method: 'log' | 'error'): { spy: any; lines: string[] } {
  const lines: string[] = [];
  const spy: any = vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
    lines.push(a.join(' '));
  });
  const clear = spy.mockClear.bind(spy);
  spy.mockClear = () => {
    lines.length = 0;
    return clear();
  };
  return { spy, lines };
}
