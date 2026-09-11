import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession, renderWithProviders, seedAuthSession, } from '@/test/renderWithProviders';
import { MessageItem } from './MessageItem';
afterEach(() => {
    cleanup();
});
beforeEach(() => {
    clearAuthSession();
    localStorage.clear();
    seedAuthSession();
});
/**
 * Build a chat message for MessageItem tests.
 *
 * @param overrides - Partial message fields
 * @returns Chat message
 */
function buildMessage(overrides) {
    return {
        id: 'm_test',
        role: 'assistant',
        content: 'Default content',
        status: 'Completed',
        createdAt: '2026-09-11T12:00:00Z',
        ...overrides,
    };
}
describe('MessageItem', () => {
    it('renders a user message', () => {
        renderWithProviders(<MessageItem message={buildMessage({
                role: 'user',
                content: 'How does authentication work?',
            })} isUser onEdit={() => undefined} onRetry={() => undefined}/>);
        expect(screen.getByText('You')).toBeTruthy();
        expect(screen.getByText('How does authentication work?')).toBeTruthy();
    });
    it('renders an assistant message with markdown content', () => {
        renderWithProviders(<MessageItem message={buildMessage({
                content: '## How authentication works\n\nJWT sessions.',
                status: 'Completed',
                knowledgeVersion: 'v3',
                evidence: [
                    {
                        file: 'src/auth/login.ts',
                        location: 'L10-L40',
                        snippet: 'export function login() {}',
                    },
                ],
            })} isUser={false} onEdit={() => undefined} onRetry={() => undefined}/>);
        expect(screen.getByText('S')).toBeTruthy();
        expect(screen.getByText(/How authentication works/i)).toBeTruthy();
        expect(screen.getByText(/1 source/i)).toBeTruthy();
    });
    it('renders abstain notice with retry actions', () => {
        const onRetry = vi.fn();
        renderWithProviders(<MessageItem message={buildMessage({
                content: '',
                abstain: true,
                missing: ['payment provider docs'],
                status: 'Completed',
            })} isUser={false} onEdit={() => undefined} onRetry={onRetry}/>);
        expect(screen.getByText(/does not currently contain enough information/i)).toBeTruthy();
        expect(screen.getByText('payment provider docs')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Try a narrower question/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /^Retry$/i })).toBeTruthy();
    });
    it('renders failed assistant messages with retry', () => {
        const onRetry = vi.fn();
        renderWithProviders(<MessageItem message={buildMessage({
                content: '',
                status: 'Failed',
            })} isUser={false} onEdit={() => undefined} onRetry={onRetry}/>);
        fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
        expect(onRetry).toHaveBeenCalled();
    });
    it('expands evidence sources and shows searching status', () => {
        renderWithProviders(<MessageItem message={buildMessage({
                content: 'Working…',
                status: 'Searching',
            })} isUser={false} onEdit={() => undefined} onRetry={() => undefined}/>);
        expect(screen.getByText(/Searching/i)).toBeTruthy();
        renderWithProviders(<MessageItem message={buildMessage({
                content: 'Done',
                status: 'Completed',
                knowledgeVersion: 'v3',
                evidence: [
                    {
                        file: 'src/auth/login.ts',
                        location: 'L10-L40',
                        snippet: 'export function login() {}',
                    },
                ],
            })} isUser={false} onEdit={() => undefined} onRetry={() => undefined}/>);
        fireEvent.click(screen.getByRole('button', { name: /1 source/i }));
        expect(screen.getByText('src/auth/login.ts')).toBeTruthy();
        expect(screen.getByText('export function login() {}')).toBeTruthy();
    });
});
