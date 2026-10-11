import { cn } from '@/shared/lib/utils';
import { describe, expect, it } from 'vitest';

describe('cn', () => {
  it('merges class names and resolves Tailwind conflicts', () => {
    const omitHidden = false;
    expect(cn('px-2', 'py-1')).toContain('px-2');
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-sm', omitHidden && 'hidden', 'font-medium')).toBe('text-sm font-medium');
    expect(cn('bg-red-500', { 'bg-blue-500': true })).toBe('bg-blue-500');
  });
});
