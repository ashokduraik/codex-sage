import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  clearSession,
  getAccessToken,
  resetApiSessionForTests,
  setAccessToken,
  subscribeSessionCleared,
} from '@/shared/api/apiSession.js';

describe('apiSession', () => {
  beforeEach(() => {
    resetApiSessionForTests();
  });

  it('sets and gets the access token', () => {
    expect(getAccessToken()).toBeNull();
    setAccessToken('token-a');
    expect(getAccessToken()).toBe('token-a');
  });

  it('clears the session and notifies subscribers once per clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionCleared(listener);
    setAccessToken('token-a');
    clearSession();
    expect(getAccessToken()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    clearSession();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    clearSession();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
