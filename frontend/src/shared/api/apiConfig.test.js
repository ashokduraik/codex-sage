import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './apiConfig.js';

describe('resolveApiBaseUrl', () => {
  it('accepts a same-origin path and trims trailing slashes', () => {
    expect(resolveApiBaseUrl('/api/v1')).toBe('/api/v1');
    expect(resolveApiBaseUrl('/api/v1/')).toBe('/api/v1');
    expect(resolveApiBaseUrl('  /api/v1///  ')).toBe('/api/v1');
  });

  it('accepts an absolute http(s) URL and trims trailing slashes', () => {
    expect(resolveApiBaseUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1',
    );
    expect(resolveApiBaseUrl('http://localhost:3000/api/v1/')).toBe(
      'http://localhost:3000/api/v1',
    );
  });

  it('throws a message naming VITE_API_BASE_URL when missing', () => {
    expect(() => resolveApiBaseUrl(undefined)).toThrow(/VITE_API_BASE_URL/);
    expect(() => resolveApiBaseUrl('')).toThrow(/VITE_API_BASE_URL/);
    expect(() => resolveApiBaseUrl('   ')).toThrow(/VITE_API_BASE_URL/);
  });

  it('throws when a path incorrectly embeds a scheme', () => {
    expect(() => resolveApiBaseUrl('/api://evil')).toThrow(/VITE_API_BASE_URL/);
  });

  it('throws when the value is malformed', () => {
    expect(() => resolveApiBaseUrl('ftp://example.com')).toThrow(/VITE_API_BASE_URL/);
    expect(() => resolveApiBaseUrl('not-a-url')).toThrow(/VITE_API_BASE_URL/);
    expect(() => resolveApiBaseUrl('://broken')).toThrow(/VITE_API_BASE_URL/);
  });
});
