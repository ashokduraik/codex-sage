import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from '@/shared/components/ErrorBoundary';
import { clearAuthSession, renderWithProviders } from '@tests/renderWithProviders';
afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.restoreAllMocks();
});
/**
 * Child that throws once on render for ErrorBoundary coverage.
 */
function ThrowingChild({ shouldThrow }) {
    if (shouldThrow) {
        throw new Error('boom');
    }
    return <p>Recovered content</p>;
}
describe('ErrorBoundary', () => {
    beforeEach(() => {
        clearAuthSession();
        localStorage.clear();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });
    it('catches a child throw and shows the fallback UI', () => {
        renderWithProviders(<ErrorBoundary>
        <ThrowingChild shouldThrow/>
      </ErrorBoundary>);
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(screen.getByText(/This view crashed/i)).toBeTruthy();
        expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy();
    });
    it('resets and remounts children after try again', () => {
        let shouldThrow = true;
        function Flaky() {
            return <ThrowingChild shouldThrow={shouldThrow}/>;
        }
        renderWithProviders(<ErrorBoundary>
        <Flaky />
      </ErrorBoundary>);
        expect(screen.getByRole('alert')).toBeTruthy();
        shouldThrow = false;
        fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
        expect(screen.getByText('Recovered content')).toBeTruthy();
    });
    it('supports a custom fallback renderer', () => {
        renderWithProviders(<ErrorBoundary fallback={(reset) => (<button type="button" onClick={reset}>
          Custom reset
        </button>)}>
        <ThrowingChild shouldThrow/>
      </ErrorBoundary>);
        expect(screen.getByRole('button', { name: 'Custom reset' })).toBeTruthy();
    });
});
