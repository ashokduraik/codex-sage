import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDateTime, formatRelative } from '@/shared/lib/format';
describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('returns an em dash for nullish values', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
  });
  it('returns just now for timestamps under a minute old', () => {
    expect(formatRelative('2026-09-11T11:59:30.000Z')).toBe('just now');
  });
  it('returns minutes ago for timestamps under an hour', () => {
    expect(formatRelative('2026-09-11T11:45:00.000Z')).toBe('15m ago');
  });
  it('returns hours ago for timestamps under a day', () => {
    expect(formatRelative('2026-09-11T09:00:00.000Z')).toBe('3h ago');
  });
  it('returns days ago for timestamps under a week', () => {
    expect(formatRelative('2026-09-09T12:00:00.000Z')).toBe('2d ago');
  });
  it('returns a short date for older timestamps', () => {
    const label = formatRelative('2026-08-01T12:00:00.000Z');
    expect(label).not.toMatch(/ago/);
    expect(label.length).toBeGreaterThan(0);
  });
});
describe('formatDateTime', () => {
  it('returns an em dash for nullish values', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime(undefined)).toBe('—');
  });
  it('formats a valid ISO timestamp', () => {
    const label = formatDateTime('2026-09-11T12:30:00.000Z');
    expect(label).toMatch(/Sep/);
    expect(label).toMatch(/11/);
  });
});
