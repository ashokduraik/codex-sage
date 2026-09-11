import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { safeReturnTo } from '@/features/auth/authReturnTo';

describe('safeReturnTo', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        origin: 'http://localhost',
        href: 'http://localhost/',
        search: '',
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('returns / when returnTo is missing', () => {
    window.location.search = '';
    expect(safeReturnTo()).toBe('/');
  });

  it('accepts a same-origin path', () => {
    window.location.search = '?returnTo=/projects';
    expect(safeReturnTo()).toBe('/projects');
  });

  it('rejects protocol-relative open redirects', () => {
    window.location.search = '?returnTo=/.//evil.com';
    expect(safeReturnTo()).toBe('/');
  });

  it('rejects backslash open redirects', () => {
    window.location.search = '?returnTo=/\\evil.com';
    expect(safeReturnTo()).toBe('/');
  });

  it('strips sensitive bootstrap query params', () => {
    window.location.search =
      '?returnTo=' + encodeURIComponent('/admin?access_token=secret&keep=1');
    expect(safeReturnTo()).toBe('/admin?keep=1');
  });
});
