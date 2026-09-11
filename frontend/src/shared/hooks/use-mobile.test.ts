import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useIsMobile } from './use-mobile';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useIsMobile', () => {
  it('reports mobile when the viewport is below 768px', () => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 500,
    });

    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('767'),
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.push(listener);
      },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1024,
      });
      listeners.forEach((listener) =>
        listener({ matches: false } as MediaQueryListEvent),
      );
    });
    expect(result.current).toBe(false);
  });
});
