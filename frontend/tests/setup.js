import { configure } from '@testing-library/react';
/** Allow async UI to settle under parallel jsdom workers. */
configure({ asyncUtilTimeout: 5000 });
/**
 * Vitest/Node may not expose localStorage; provide an in-memory shim for auth tests.
 */
function ensureLocalStorage() {
  if (typeof globalThis.localStorage !== 'undefined' && globalThis.localStorage !== null) {
    try {
      globalThis.localStorage.setItem('__probe__', '1');
      globalThis.localStorage.removeItem('__probe__');
      return;
    } catch {
      // fall through to shim
    }
  }
  const store = new Map();
  const memoryStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}
ensureLocalStorage();
/** input-otp probes caret position via elementFromPoint in jsdom. */
if (typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null;
}
/**
 * Polyfill matchMedia for components that query viewport (e.g. sonner toaster).
 */
if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
